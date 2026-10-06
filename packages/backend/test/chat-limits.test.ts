import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { SQL } from "bun";
import * as limits from "../src/chat/limits";
import { hashIp, MemoryChatLimiter, type ChatLimiter, type LimitConfig, type Kind } from "../src/chat/limits";

// Keep memory coverage runnable while the Postgres concurrency contract is unresolved.
const PostgresChatLimiter = (limits as { PostgresChatLimiter?: new (sql: SQL) => ChatLimiter }).PostgresChatLimiter;
test("Postgres limiter implementation is available", () => {
  expect(PostgresChatLimiter).toBeFunction();
});

const cfg: LimitConfig = { ipHourly: 10, previewIpHourly: 30, globalDaily: 100, dailyBudgetMicroUsd: 1000 };
const nowMs = 2_000_000_000_000;
const cases = (get: () => ChatLimiter) => {
  const reserve = (ipHash = "ip-a", t = nowMs, kind: Kind = "chat", reserveMicroUsd = 1, config = cfg) =>
    get().reserve({ ipHash, nowMs: t, kind, reserveMicroUsd, cfg: config });

  test("ten accepted then ip limit, separate IP unaffected", async () => {
    for (let i = 0; i < 10; i++) expect((await reserve()).ok).toBe(true);
    expect(await reserve()).toEqual({ ok: false, reason: "ip_hourly", retryAfterSec: 3600 });
    expect((await reserve("ip-b")).ok).toBe(true);
  });
  test("hourly window slides at the boundary", async () => {
    for (let i = 0; i < 10; i++) await reserve("ip-a", nowMs + i * 1000);
    expect(await reserve("ip-a", nowMs + 3_599_999)).toMatchObject({ ok: false, retryAfterSec: 1 });
    expect((await reserve("ip-a", nowMs + 3_600_000)).ok).toBe(true);
    expect(await reserve("ip-a", nowMs + 3_600_000)).toMatchObject({ ok: false, retryAfterSec: 1 });
  });
  test("global daily across IPs", async () => {
    const config = { ...cfg, globalDaily: 2 };
    await reserve("a", nowMs, "chat", 1, config);
    await reserve("b", nowMs + 1000, "chat", 1, config);
    expect(await reserve("c", nowMs + 1000, "chat", 1, config)).toEqual({ ok: false, reason: "global_daily", retryAfterSec: 86399 });
  });
  test("reserved and settled costs count, exact budget fits", async () => {
    const first = await reserve("a", nowMs, "chat", 900);
    expect(first.ok).toBe(true);
    expect(await reserve("b", nowMs, "chat", 101)).toMatchObject({ ok: false, reason: "daily_budget", retryAfterSec: 86400 });
    if (!first.ok) throw new Error("reservation failed");
    await get().settle({ id: first.id, tokens: 30, costMicroUsd: 100 });
    expect((await reserve("b", nowMs, "chat", 900)).ok).toBe(true);
    expect(await reserve("c")).toMatchObject({ ok: false, reason: "daily_budget" });
  });
  test("previews have separate hourly count and ignore exhausted budget", async () => {
    await reserve("ip-a", nowMs, "chat", 1000);
    for (let i = 0; i < 30; i++) expect((await reserve("ip-a", nowMs, "preview", 0)).ok).toBe(true);
    expect(await reserve("ip-a", nowMs, "preview", 0)).toMatchObject({ ok: false, reason: "ip_hourly" });
  });
  test("day boundary ignores expired costs and rows", async () => {
    const config = { ...cfg, globalDaily: 1 };
    await reserve("a", nowMs, "chat", 1000, config);
    expect((await reserve("a", nowMs + 86_400_000, "chat", 1000, config)).ok).toBe(true);
  });
  test("concurrent burst of 25 accepts exactly 10", async () => {
    const outcomes = await Promise.all(Array.from({ length: 25 }, () => reserve()));
    expect(outcomes.filter((r) => r.ok)).toHaveLength(10);
  });
};

describe("MemoryChatLimiter", () => {
  let limiter: ChatLimiter;
  beforeEach(() => { limiter = new MemoryChatLimiter(); });
  cases(() => limiter);
});

describe.skipIf(!process.env.TEST_DATABASE_URL)("PostgresChatLimiter", () => {
  let sql: SQL;
  let limiter: ChatLimiter;
  beforeAll(async () => {
    sql = new SQL(process.env.TEST_DATABASE_URL!);
    await sql.unsafe(await Bun.file(new URL("../../../supabase/migrations/20261006140000_chat.sql", import.meta.url)).text());
    if (!PostgresChatLimiter) throw new Error("Postgres concurrency contract is unresolved");
    limiter = new PostgresChatLimiter(sql);
  });
  beforeEach(async () => { await sql`truncate public.chat_usage`; });
  afterAll(async () => { await sql.close(); });
  cases(() => limiter);
});

test("salted IP SHA256", () => {
  expect(hashIp("127.0.0.1", "salt")).toBe(new Bun.CryptoHasher("sha256").update("salt:127.0.0.1").digest("hex"));
  expect(hashIp("127.0.0.1", "salt")).not.toBe(hashIp("127.0.0.1", "other"));
});

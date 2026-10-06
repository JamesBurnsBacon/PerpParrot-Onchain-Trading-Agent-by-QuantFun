import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { SQL } from "bun";
import { CHAT_LIMITER_LOCK_KEY, hashIp, MemoryChatLimiter, PostgresChatLimiter, type ChatLimiter, type LimitConfig, type Kind } from "../src/chat/limits";

const cfg: LimitConfig = { ipHourly: 10, previewIpHourly: 30, globalDaily: 100, dailyBudgetMicroUsd: 1000 };
const nowMs = 2_000_000_000_000;
const cases = (get: () => ChatLimiter) => {
  const reserve = (ipHash = "ip-a", t = nowMs, kind: Kind = "chat", reserveMicroUsd = 1, config = cfg) =>
    get().reserve({ ipHash, nowMs: t, kind, reserveMicroUsd, cfg: config });

  test("live counts are separate, costs shared and settlement releases either kind", async () => {
    const config = { ...cfg, ipHourly: 1, globalDaily: 1 };
    const live = await reserve("a", nowMs, "live", 600, config);
    expect(live.ok).toBe(true);
    expect(await reserve("a", nowMs, "live", 0, config)).toMatchObject({ ok: false, reason: "ip_hourly" });
    expect(await reserve("b", nowMs, "live", 0, config)).toMatchObject({ ok: false, reason: "global_daily" });
    expect(await reserve("b", nowMs, "chat", 401, config)).toMatchObject({ ok: false, reason: "daily_budget" });
    expect((await reserve("b", nowMs, "chat", 400, config)).ok).toBe(true);
    if (!live.ok) throw new Error("reserve failed");
    await get().settle({ id: live.id, tokens: 0, costMicroUsd: 0 });
    expect((await reserve("c", nowMs, "live", 600, cfg)).ok).toBe(true);
    expect(await reserve("d", nowMs, "chat", 1, cfg)).toMatchObject({ ok: false, reason: "daily_budget" });
  });
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
  test("previews ignore global limit and never consume chat count or budget", async () => {
    const config = { ...cfg, globalDaily: 1, dailyBudgetMicroUsd: 1 };
    const preview = await reserve("ip-a", nowMs, "preview", 999, config);
    expect(preview.ok).toBe(true);
    if (!preview.ok) throw new Error("preview failed");
    await get().settle({ id: preview.id, tokens: 10, costMicroUsd: 999 });
    expect((await reserve("ip-a", nowMs, "chat", 1, config)).ok).toBe(true);
    expect((await reserve("ip-a", nowMs, "preview", 999, config)).ok).toBe(true);
    expect(await reserve("ip-b", nowMs, "chat", 0, config)).toMatchObject({ ok: false, reason: "global_daily" });
    expect((await reserve("ip-b", nowMs, "preview", 999, { ...config, globalDaily: 0, dailyBudgetMicroUsd: 0 })).ok).toBe(true);
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
    const liveMigration = await Bun.file(new URL("../../../supabase/migrations/20261007000000_live_usage.sql", import.meta.url)).text();
    await sql.unsafe(liveMigration);
    await sql.unsafe(liveMigration);
    limiter = new PostgresChatLimiter(sql);
  });
  beforeEach(async () => { await sql`truncate public.chat_usage`; });
  afterAll(async () => { await sql.close(); });
  cases(() => limiter);

  // Deterministic proof that reserve takes the advisory lock: a burst can pass by luck, this cannot.
  test("reserve waits while another transaction holds the advisory lock", async () => {
    const cfg: LimitConfig = { ipHourly: 10, previewIpHourly: 30, globalDaily: 100, dailyBudgetMicroUsd: 5_000_000 };
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    let locked!: () => void;
    const lockTaken = new Promise<void>((resolve) => { locked = resolve; });
    const holder = sql.begin(async (tx) => {
      await tx`select pg_advisory_xact_lock(${CHAT_LIMITER_LOCK_KEY}::bigint)`;
      locked();
      await held;
    });
    await lockTaken;
    let settled = false;
    const pending = limiter.reserve({ ipHash: "h", kind: "chat", nowMs: Date.now(), reserveMicroUsd: 1, cfg }).then((r) => {
      settled = true;
      return r;
    });
    await Bun.sleep(300);
    expect(settled).toBe(false);
    release();
    await holder;
    expect((await pending).ok).toBe(true);
  });
});

test("salted IP SHA256", () => {
  expect(hashIp("127.0.0.1", "salt")).toBe(new Bun.CryptoHasher("sha256").update("salt:127.0.0.1").digest("hex"));
  expect(hashIp("127.0.0.1", "salt")).not.toBe(hashIp("127.0.0.1", "other"));
});


// Tagged-template double: rejects SQL outside the transaction during reserve.
const fakeSql = (counts: Record<string, unknown> = {}) => {
  const statements: { text: string; values: unknown[] }[] = [];
  let inTransaction = false;
  const query = async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = strings.join("?").replace(/\s+/g, " ").trim();
    statements.push({ text, values });
    if (!text.startsWith("update")) expect(inTransaction).toBe(true);
    if (text.startsWith("select") && !text.includes("pg_advisory_xact_lock"))
      return [{ hourly_count: "0", hourly_oldest: null, daily_count: "0", daily_oldest: null, daily_cost: "0", ...counts }];
    if (text.startsWith("insert")) return [{ id: "42" }];
    return [];
  };
  const sql = Object.assign(query, { begin: async (fn: (tx: typeof query) => Promise<unknown>) => {
    statements.push({ text: "begin", values: [] });
    inTransaction = true;
    try { return await fn(query); }
    finally { inTransaction = false; statements.push({ text: "end", values: [] }); }
  } }) as unknown as SQL;
  return { sql, statements };
};

test("Postgres reserve locks first, then counts, then inserts in one transaction; settle is one update", async () => {
  expect(PostgresChatLimiter).toBeFunction();
  const { sql, statements } = fakeSql();
  const limiter = new PostgresChatLimiter(sql);
  expect(await limiter.reserve({ ipHash: "ip-a", kind: "chat", nowMs, reserveMicroUsd: 123, cfg })).toEqual({ ok: true, id: "42" });
  expect(statements).toHaveLength(5);
  expect(statements[0].text).toBe("begin");
  expect(statements[1].text).toMatch(/^select pg_advisory_xact_lock\(/);
  expect(statements[2].text).toContain("count(*)");
  expect(statements[2].text).toContain("from public.chat_usage");
  expect(statements[2].values).toContain(nowMs - 86_400_000);
  expect(statements[2].values).toContain(nowMs - 3_600_000);
  expect(statements[3].text).toMatch(/^insert into public.chat_usage/);
  expect(statements[3].values).toEqual(["chat", nowMs, "ip-a", 123]);
  expect(statements[4].text).toBe("end");
  await limiter.settle({ id: "42", tokens: 9, costMicroUsd: 17 });
  expect(statements).toHaveLength(6);
  expect(statements[5].text).toMatch(/^update public.chat_usage/);
  expect(statements[5].values).toEqual([9, 17, "42"]);
});

test.each([
  [{ hourly_count: "10", hourly_oldest: nowMs - 1000 }, "ip_hourly", 3599],
  [{ daily_count: "100", daily_oldest: nowMs - 1000 }, "global_daily", 86399],
  [{ daily_cost: "1000", daily_oldest: nowMs - 1000 }, "daily_budget", 86399],
] as const)("Postgres denial never inserts: %j", async (counts, reason, retryAfterSec) => {
  const { sql, statements } = fakeSql(counts);
  const limiter = new PostgresChatLimiter(sql);
  expect(await limiter.reserve({ ipHash: "a", kind: "chat", nowMs, reserveMicroUsd: 1, cfg })).toEqual({ ok: false, reason, retryAfterSec });
  expect(statements.map((s) => s.text).some((s) => s.startsWith("insert"))).toBe(false);
  expect(statements.at(-1)?.text).toBe("end");
});

test("Postgres preview bypasses exhausted chat limits and inserts zero cost", async () => {
  const { sql, statements } = fakeSql({ daily_count: "100", daily_cost: "1000" });
  const limiter = new PostgresChatLimiter(sql);
  expect((await limiter.reserve({ ipHash: "a", kind: "preview", nowMs, reserveMicroUsd: 999, cfg })).ok).toBe(true);
  expect(statements[3].values).toEqual(["preview", nowMs, "a", 0]);
});

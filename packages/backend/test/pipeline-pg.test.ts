// The pipeline's SQL against a real Postgres (TEST_DATABASE_URL; see pg-store.test.ts), with
// Hyperliquid and the vault site mocked: scan → refresh → qualify → refresh fills → pick.
import { afterAll, describe, expect, test } from "bun:test";
import { SQL } from "bun";
import { Pipeline } from "../src/pipeline";
import { PacedInfo } from "../src/pipeline/hl";
import type { Policy } from "../../shared/src/contracts.ts";
import sample from "./fixtures/score/portfolio-sample.json";

const url = process.env.TEST_DATABASE_URL;
const NOW = Date.parse("2026-10-06T07:00:00Z"); // just after the sample's last point
const address = (i: number) => `0x${(i + 1).toString(16).padStart(40, "0")}`;
const migration = (name: string) => Bun.file(new URL(`../../../supabase/migrations/${name}`, import.meta.url)).text();

describe.skipIf(!url)("Pipeline on Postgres", async () => {
  if (!url) return;
  const sql = new SQL(url, { prepare: false }); // as production (transaction pooler)
  await sql.unsafe("drop table if exists configurations, selection_runs, pipeline_accounts cascade");
  await sql.unsafe(await migration("20261007120000_pipeline.sql"));
  await sql.unsafe(await migration("20261007150000_pipeline_qualified.sql"));
  await sql.unsafe(await migration("20261007150000_pipeline_qualified.sql")); // safe to run twice
  await sql.unsafe(await migration("20261007160000_pipeline_primary.sql"));
  await sql.unsafe(await migration("20261007160000_pipeline_primary.sql"));

  // Leaderboard: every sample account (≥ $10k ones pass the scan). No vaults from either list.
  const leaderboardRows = sample.map((s, i) => ({
    ethAddress: address(i),
    accountValue: String(s.accountValue),
    displayName: null,
    windowPerformances: [["month", { pnl: "1", roi: "0", vlm: "0" }], ["allTime", { pnl: "1", roi: "0", vlm: "0" }]],
  }));
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request) => {
    const target = String(input instanceof Request ? input.url : input);
    if (target.endsWith("/leaderboard")) return Response.json({ leaderboardRows });
    if (target.endsWith("/vaults")) return Response.json([]);
    return new Response("not found", { status: 404 }); // hyperliquidvaults.com
  }) as typeof fetch;
  afterAll(() => {
    globalThis.fetch = realFetch;
  });

  // Hyperliquid info: the sample's portfolios; fills of `ordersPerDay(i)` orders a day.
  const calls: string[] = [];
  const highFrequency = new Set<string>(); // chosen from the qualified list below
  const ordersPerDay = (i: number) => (highFrequency.has(address(i)) ? 500 : 2);
  const info = (async (_: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body)) as { type: string; user: string };
    calls.push(body.type);
    const i = Number.parseInt(body.user.slice(2), 16) - 1;
    if (body.type === "portfolio") return Response.json(sample[i].portfolio);
    const n = Math.min(ordersPerDay(i) * 30, 2_000);
    const span = ordersPerDay(i) > 66 ? 4 * 86_400_000 : 30 * 86_400_000;
    return Response.json(Array.from({ length: n }, (_, k) => ({ coin: "BTC", oid: k, px: "100", sz: "1", crossed: k % 2 === 0, time: NOW - span + (k * span) / n })));
  }) as unknown as typeof fetch;

  const pipelineAt = (nowMs: number) =>
    new Pipeline({
      sql,
      account: address(999),
      policy: {} as Policy,
      log: () => {},
      now: () => nowMs,
      info: (perMinute) => new PacedInfo(perMinute, info, async () => {}),
    });
  const pipeline = pipelineAt(NOW);
  const passing = sample.filter((s) => s.accountValue >= 10_000).length;

  test("scan lists every ≥ $10k leaderboard account once, and is safe to repeat", async () => {
    expect(await pipeline.scan()).toEqual({ leaderboard: passing, vaults: 0 });
    expect(await pipeline.scan()).toEqual({ leaderboard: passing, vaults: 0 });
    const [{ n, primary }] = await sql`select count(*)::int as n, count(*) filter (where primary_source)::int as primary from pipeline_accounts`;
    expect(n).toBe(passing);
    expect(primary).toBe(passing); // all within the leaderboard's top 200
  });

  test("refresh stores the scoring windows only, without fills, and releases nothing it finished", async () => {
    const result = await pipeline.refresh(Date.now() + 240_000);
    expect(result).toEqual({ scanned: false, refreshed: passing, failed: 0 });
    expect(calls.every((c) => c === "portfolio")).toBe(true);
    const rows = await sql`select portfolio, attempted_at, fills_at from pipeline_accounts`;
    expect(rows.every((r: { portfolio: [string][] }) => r.portfolio.every(([w]) => w === "month" || w === "allTime"))).toBe(true);
    expect(rows.every((r: { attempted_at: Date | null; fills_at: Date | null }) => r.attempted_at === null && r.fills_at === null)).toBe(true);
  });

  test("qualifying waits for every primary source, and for 95% of the scan unless it is 3.5 h old", async () => {
    const [primary, ...others] = (await sql`select address from pipeline_accounts order by address`).map((r: { address: string }) => r.address);
    await sql`update pipeline_accounts set primary_source = false where address <> ${primary}`;
    await sql`update pipeline_accounts set portfolio = null, refreshed_at = null where address in ${sql(others.slice(0, 3))}`; // < 95% fresh
    const qualifiedCount = async () => (await sql`select count(*)::int as n from pipeline_accounts where qualified_at is not null`)[0].n;
    expect(await pipeline.select()).toEqual({ status: "waiting", reason: "no qualified list yet" });
    await sql`update pipeline_accounts set portfolio = null, refreshed_at = null where address = ${primary}`;
    const later = pipelineAt(NOW + 3.6 * 3_600_000);
    expect((await later.select()).reason).toBe("no qualified list yet"); // the primary isn't fresh
    expect(await qualifiedCount()).toBe(0);
    await pipeline.refresh(Date.now() + 240_000); // reads the 4 accounts back
    await sql`update pipeline_accounts set portfolio = null, refreshed_at = null where address in ${sql(others.slice(0, 3))}`;
    expect((await later.select()).reason).toMatch(/qualified accounts have fresh fills$/); // qualified on what is fresh
    expect(await qualifiedCount()).toBeGreaterThan(0);
    // Back to a fully refreshed scan for the steps below.
    await sql`update pipeline_accounts set qualified_at = null, primary_source = true`;
    await pipeline.refresh(Date.now() + 240_000);
  });

  test("select qualifies the scan, then waits for the qualified list's fills", async () => {
    expect(await pipeline.select()).toEqual({ status: "waiting", reason: expect.stringMatching(/^0\/\d+ qualified accounts have fresh fills$/) });
    const [{ qualified }] = await sql`select count(*)::int as qualified from pipeline_accounts where qualified_at is not null`;
    expect(qualified).toBeGreaterThan(5);
    expect(qualified).toBeLessThanOrEqual(passing);
  });

  test("refresh reads the qualified accounts' fills first", async () => {
    calls.length = 0;
    const [{ address: hft }] = await sql`select address from pipeline_accounts where qualified_at is not null order by address limit 1`;
    highFrequency.add(hft);
    await pipeline.refresh(Date.now() + 240_000);
    expect(calls).toContain("userFillsByTime");
    const [{ missing }] = await sql`select count(*)::int as missing from pipeline_accounts where qualified_at is not null and fills_at is null`;
    expect(missing).toBe(0);
    const [row] = await sql`select orders_per_day from pipeline_accounts where address = ${hft}`;
    expect(row.orders_per_day).toBeCloseTo(500, -1);
    const [normal] = await sql`select orders_per_day from pipeline_accounts where qualified_at is not null and address <> ${hft} limit 1`;
    expect(normal.orders_per_day).toBeCloseTo(2);
  });

  test("a pick leaves out high-frequency traders, and an unchanged pick isn't reviewed again", async () => {
    // No OpenAI key and an empty policy: the review fails after the pick is saved.
    const first = await pipeline.select();
    expect(first.status).toBe("failed");
    const [run] = await sql`select finalists from selection_runs where id = ${first.id!}`;
    const picked = (run.finalists.finalists as { address: string }[]).map((f) => f.address);
    expect(picked.length).toBeGreaterThan(0);
    expect(picked).not.toContain([...highFrequency][0]);
    expect(run.finalists.highFrequency).toBe(1);
    // A failed run is retried; a rejected one with the same 25 isn't reviewed again.
    await sql`update selection_runs set status = 'rejected' where id = ${first.id!}`;
    expect(await pipeline.select()).toEqual({ status: "unchanged" });
    // A different pick waits while a review runs.
    await sql`update selection_runs set finalists = '{"finalists": []}'::jsonb, status = 'running', started_at = now() where id = ${first.id!}`;
    expect(await pipeline.select()).toEqual({ status: "waiting", reason: "a review is running" });
  });

  test("status counts the scan and the qualified list", async () => {
    const { accounts } = await pipeline.status();
    expect(accounts.listed).toBe(passing);
    expect(accounts.qualified).toBeGreaterThan(5);
  });

  test("the overlap guard drops a candidate that holds the same book as a better one, and says so", async () => {
    // Free the review slot the earlier tests left running.
    await sql`update selection_runs set status = 'failed', started_at = now() - interval '2 hours'`;
    const asked: string[] = [];
    const logs: string[] = [];
    // The first two candidates asked (rank order) hold the same book; every other one has its own market.
    const positions = async (a: string) => {
      asked.push(a);
      const market = asked.indexOf(a) < 2 ? "BTC" : `M${a}`;
      return [{ market, signedNotionalUsd: 1000, leverage: null, liquidationDistance: null }];
    };
    const make = (guard: boolean) =>
      new Pipeline({
        sql,
        account: address(999),
        policy: { maxExposureOverlap: 0.5 } as Policy,
        log: (m, d) => void logs.push(`${m} ${JSON.stringify(d)}`),
        now: () => NOW,
        info: (perMinute) => new PacedInfo(perMinute, info, async () => {}),
        overlapGuard: guard,
        positions,
        picks: 8, // of the 10 candidates the sample leaves

      });
    const picksOf = async (id: number) => {
      const [run] = await sql`select finalists from selection_runs where id = ${id}`;
      return run.finalists as { finalists: { address: string }[]; overlapGuard?: { excluded: number; reads: number; pool: number } };
    };

    const off = await make(false).select(true);
    const baseline = await picksOf(off.id!);
    expect(baseline.overlapGuard).toBeUndefined(); // off: the saved pick has no new field
    expect(asked).toEqual([]); // and no reads

    await sql`update selection_runs set status = 'failed', started_at = now() - interval '2 hours'`;
    const on = await make(true).select(true);
    const guarded = await picksOf(on.id!);
    const [first, second] = asked;
    expect(logs.filter((l) => l.startsWith("overlap guard"))).toEqual([expect.stringContaining('"excluded":1')]);
    const names = baseline.finalists.map((f) => f.address);
    expect(names).toContain(second!);
    expect(guarded.finalists.map((f) => f.address)).not.toContain(second!);
    expect(guarded.finalists.map((f) => f.address)).toContain(first!);
    expect(guarded.overlapGuard).toMatchObject({ excluded: 1 });
    expect(guarded.overlapGuard!.pool).toBeLessThanOrEqual(60);
    expect(guarded.finalists).toHaveLength(8); // the count does not shrink
    expect(baseline.finalists).toHaveLength(8);
  });

  test("a failed book read leaves the pick exactly as Score made it", async () => {
    await sql`update selection_runs set status = 'failed', started_at = now() - interval '2 hours'`;
    const make = (positions: (a: string) => Promise<never>) =>
      new Pipeline({ sql, account: address(999), policy: { maxExposureOverlap: 0.5 } as Policy, log: () => {}, now: () => NOW, info: (perMinute) => new PacedInfo(perMinute, info, async () => {}), overlapGuard: true, positions, picks: 8 });
    const run = await make(async () => Promise.reject(new Error("down"))).select(true);
    const [row] = await sql`select finalists from selection_runs where id = ${run.id!}`;
    expect(row.finalists.overlapGuard).toBeUndefined();
    await sql`update selection_runs set status = 'failed', started_at = now() - interval '2 hours'`;
    const plain = await new Pipeline({ sql, account: address(999), policy: { maxExposureOverlap: 0.5 } as Policy, log: () => {}, now: () => NOW, info: (perMinute) => new PacedInfo(perMinute, info, async () => {}), overlapGuard: false, picks: 8 }).select(true);
    const [base] = await sql`select finalists from selection_runs where id = ${plain.id!}`;
    expect(row.finalists.finalists).toEqual(base.finalists.finalists);
  });

  test("recording the picks' overlap adds one field and leaves the saved pick untouched", async () => {
    const saved = { finalists: [{ address: "0xa", rank: 1 }], funnel: [{ stage: "scored", count: 3 }], highFrequency: 2 };
    const [{ id }] = await sql`insert into selection_runs (started_at, status, finalists) values (now(), 'rejected', ${JSON.stringify(saved)}::jsonb) returning id`;
    const overlap = { threshold: 0.5, pairs: 1, above: 0, max: 0.4, top: [], byAddress: { "0xa": 0.4 } };
    await sql`update selection_runs set finalists = coalesce(finalists, '{}'::jsonb) || ${JSON.stringify({ overlap })}::jsonb where id = ${id}`;
    const [run] = await sql`select finalists from selection_runs where id = ${id}`;
    expect(run.finalists).toEqual({ ...saved, overlap });
    // A run whose pick was never saved still records (coalesce) instead of silently staying null.
    const [{ id: bare }] = await sql`insert into selection_runs (started_at, status) values (now(), 'rejected') returning id`;
    await sql`update selection_runs set finalists = coalesce(finalists, '{}'::jsonb) || ${JSON.stringify({ overlap })}::jsonb where id = ${bare}`;
    const [fresh] = await sql`select finalists from selection_runs where id = ${bare}`;
    expect(fresh.finalists).toEqual({ overlap });
    await sql`delete from selection_runs where id in ${sql([id, bare])}`;
  });
});

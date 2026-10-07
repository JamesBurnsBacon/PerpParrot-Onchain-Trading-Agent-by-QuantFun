// Runs against a real Postgres when TEST_DATABASE_URL is set (the migration is applied first):
//   docker run -d --rm -e POSTGRES_PASSWORD=pp -p 54329:5432 postgres:16-alpine
//   TEST_DATABASE_URL=postgres://postgres:pp@localhost:54329/postgres bun test
import { describe, expect, test } from "bun:test";
import { SQL } from "bun";
import { postgresRunLock } from "../src/lock";
import { PostgresStore } from "../src/pg-store";
import { summarize, type RunRecord } from "../src/store";

const url = process.env.TEST_DATABASE_URL;

// describe.skipIf still runs the describe body, so connect lazily.
describe.skipIf(!url)("PostgresStore", async () => {
  if (!url) return;
  const sql = new SQL(url);
  await sql.unsafe(await Bun.file(new URL("../../../supabase/migrations/20261006120000_mirror.sql", import.meta.url)).text());
  await sql.unsafe(await Bun.file(new URL("../../../supabase/migrations/20261006180000_executor_order_journal.sql", import.meta.url)).text());
  const store = new PostgresStore(sql);
  const unique = `${Date.now()}-${Math.random()}`;

  test("claims a run exactly once, even concurrently", async () => {
    const id = `mirror-${unique}`;
    const claims = await Promise.all([store.claimRun(id), store.claimRun(id), store.claimRun(id)]);
    expect(claims.filter(Boolean)).toHaveLength(1);
    expect(await store.claimRun(id)).toBe(false);
  });

  test("saves and reads back runs, newest first", async () => {
    const run = (id: string, startedAt: number): RunRecord => ({
      id,
      runId: `mirror-${startedAt}`,
      kind: "mirror",
      status: "executed",
      dryRun: true,
      startedAt,
      finishedAt: startedAt + 50,
      equityUsd: 470.12,
      plan: { orders: [], skipped: [], marginScale: 1, initialMarginUsd: 0 },
      results: [],
      evidence: { snapshotHash: `0x${"cd".repeat(32)}`, configurationHash: `0x${"ab".repeat(32)}`, exposures: [] },
    });
    const base = Date.now() + 1e9;
    await store.saveRun(run(`a-${unique}`, base));
    await store.saveRun(run(`b-${unique}`, base + 1000));
    const [newest, older] = await store.recentRuns(2);
    expect(newest).toEqual(run(`b-${unique}`, base + 1000));
    expect(older.id).toBe(`a-${unique}`);
    const [summary] = await store.recentRunSummaries(1);
    expect(summary).toEqual(summarize(run(`b-${unique}`, base + 1000)));
    // runId mirror-<startedAt> here, so the curve's time is startedAt × 1000.
    expect((await store.equityCurve()).filter((p) => p.t >= base * 1000)).toEqual([
      { t: base * 1000, equityUsd: 470.12, dryRun: true },
      { t: (base + 1000) * 1000, equityUsd: 470.12, dryRun: true },
    ]);
  });

  test("journals each batch before dispatch and recovers unresolved state", async () => {
    const id = `batch-${unique}`;
    await store.beginOrderBatch({
      id, runId: `report-${unique}`, createdAt: Date.now(),
      orders: [{ asset: "BTC", assetId: 0, isBuy: true, price: "100", size: "1", reduceOnly: false, notionalUsd: 100, targetUsd: 100, currentUsd: 0 }],
      cloids: [`0x${"01".repeat(16)}` as `0x${string}`], kind: "orders",
    });
    // Only this test's batches: the database may hold others (earlier runs, other tests).
    const mine = async () => (await store.unresolvedOrderBatches()).filter((b) => b.id === `batch-${unique}` || b.id === `leverage-${unique}`);
    const [dispatching] = await mine();
    expect(dispatching).toMatchObject({
      id,
      state: "dispatching",
      orders: [{ asset: "BTC", assetId: 0, isBuy: true, price: "100", size: "1" }],
      cloids: [`0x${"01".repeat(16)}`],
    });
    const results = [{ asset: "BTC", status: "unknown" as const, error: "response lost" }];
    await store.finishOrderBatch(id, results);
    expect((await mine())[0]).toMatchObject({ id, state: "uncertain", results });
    await store.reconcileOrderBatch(id, "test-operator", "verified exchange order status and position", Date.now());
    expect(await mine()).toEqual([]);

    const leverageId = `leverage-${unique}`;
    const details = { asset: "BTC", assetId: 0, leverage: 3 };
    await store.beginOrderBatch({
      id: leverageId, runId: `report-${unique}`, createdAt: Date.now(),
      orders: [], cloids: [], kind: "leverage", details,
    });
    expect(await mine()).toMatchObject([{ id: leverageId, kind: "leverage", details, orders: [], cloids: [] }]);
  });

  test("persists the kill switch", async () => {
    const controls = { paused: true, updatedAt: Date.parse("2026-10-07T12:00:00Z"), updatedBy: "james" };
    await store.setControls(controls);
    expect(await store.getControls()).toEqual(controls);
    await store.setControls({ ...controls, paused: false });
    expect((await store.getControls()).paused).toBe(false);
  });
});

describe.skipIf(!process.env.TEST_DATABASE_URL)("postgresRunLock", () => {
  test("one holder across connections; released for the next; times out while held", async () => {
    const sqlA = new SQL(process.env.TEST_DATABASE_URL!);
    const sqlB = new SQL(process.env.TEST_DATABASE_URL!);
    const key = 900_000 + Math.floor(Math.random() * 1000); // not the production key
    const a = postgresRunLock(sqlA, key);
    const b = postgresRunLock(sqlB, key);
    const releaseA = await a.acquire(1000);
    await expect(b.acquire(600)).rejects.toThrow("held the run lock");
    const waiting = b.acquire(5000); // gets it once A releases
    await Bun.sleep(300);
    await releaseA();
    const releaseB = await waiting;
    await releaseB();
    await sqlA.close();
    await sqlB.close();
  });
});

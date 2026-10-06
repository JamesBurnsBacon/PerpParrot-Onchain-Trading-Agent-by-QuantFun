// Runs against a real Postgres when TEST_DATABASE_URL is set (the migration is applied first):
//   docker run -d --rm -e POSTGRES_PASSWORD=pp -p 54329:5432 postgres:16-alpine
//   TEST_DATABASE_URL=postgres://postgres:pp@localhost:54329/postgres bun test
import { describe, expect, test } from "bun:test";
import { SQL } from "bun";
import { PostgresStore } from "../src/pg-store";
import type { RunRecord } from "../src/store";

const url = process.env.TEST_DATABASE_URL;

// describe.skipIf still runs the describe body, so connect lazily.
describe.skipIf(!url)("PostgresStore", async () => {
  if (!url) return;
  const sql = new SQL(url);
  await sql.unsafe(await Bun.file(new URL("../../../supabase/migrations/20261006120000_cre_mirror.sql", import.meta.url)).text());
  await sql.unsafe(await Bun.file(new URL("../../../supabase/migrations/20261006180000_executor_order_journal.sql", import.meta.url)).text());
  const store = new PostgresStore(sql);
  const unique = `${Date.now()}-${Math.random()}`;

  test("claims a report ID exactly once, even concurrently", async () => {
    const id = `report-${unique}`;
    const claims = await Promise.all([store.claimReport(id), store.claimReport(id), store.claimReport(id)]);
    expect(claims.filter(Boolean)).toHaveLength(1);
    expect(await store.claimReport(id)).toBe(false);
  });

  test("saves and reads back runs, newest first", async () => {
    const run = (id: string, startedAt: number): RunRecord => ({
      id,
      runId: `mirror-${startedAt}`,
      kind: "report",
      status: "executed",
      dryRun: true,
      startedAt,
      finishedAt: startedAt + 50,
      equityUsd: 470.12,
      plan: { orders: [], skipped: [], marginScale: 1, initialMarginUsd: 0 },
      results: [],
      envelope: { report: "ab", context: "cd", signatures: ["ef"] },
    });
    const base = Date.now() + 1e9;
    await store.saveRun(run(`a-${unique}`, base));
    await store.saveRun(run(`b-${unique}`, base + 1000));
    const [newest, older] = await store.recentRuns(2);
    expect(newest).toEqual(run(`b-${unique}`, base + 1000));
    expect(older.id).toBe(`a-${unique}`);
  });

  test("holds a database-wide lock across executor instances", async () => {
    const other = new PostgresStore(sql);
    let entered!: () => void;
    let release!: () => void;
    const started = new Promise<void>((resolve) => { entered = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const owner = store.withExecutionLock(async () => { entered(); await gate; });
    await started;
    await expect(other.withExecutionLock(async () => {})).rejects.toThrow("another executor instance");
    release();
    await owner;
    await expect(other.withExecutionLock(async () => "acquired")).resolves.toBe("acquired");
  });

  test("journals each batch before dispatch and recovers unresolved state", async () => {
    const id = `batch-${unique}`;
    await store.beginOrderBatch({
      id, reportId: `report-${unique}`, createdAt: Date.now(),
      orders: [{ asset: "BTC", assetId: 0, isBuy: true, price: "100", size: "1", reduceOnly: false, notionalUsd: 100, targetUsd: 100, currentUsd: 0 }],
      cloids: [`0x${"01".repeat(16)}` as `0x${string}`], kind: "orders",
    });
    expect(await store.unresolvedOrderBatches()).toHaveLength(1);
    await store.finishOrderBatch(id, [{ asset: "BTC", status: "unknown", error: "response lost" }]);
    expect((await store.unresolvedOrderBatches())[0]).toMatchObject({ id, state: "uncertain" });
    await store.reconcileOrderBatch(id, "test-operator", "verified exchange order status and position", Date.now());
    expect(await store.unresolvedOrderBatches()).toEqual([]);
  });

  test("persists the kill switch", async () => {
    const controls = { paused: true, updatedAt: Date.parse("2026-10-07T12:00:00Z"), updatedBy: "james" };
    await store.setControls(controls);
    expect(await store.getControls()).toEqual(controls);
    await store.setControls({ ...controls, paused: false });
    expect((await store.getControls()).paused).toBe(false);
  });
});

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
  await sql.unsafe(await Bun.file(new URL("../../../supabase/migrations/20261006120000_cre_mirror.sql", import.meta.url)).text());
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
    const [summary] = await store.recentRunSummaries(1);
    expect(summary).toEqual(summarize(run(`b-${unique}`, base + 1000)));
    // runId mirror-<startedAt> here, so the curve's time is startedAt × 1000.
    expect((await store.equityCurve()).filter((p) => p.t >= base * 1000)).toEqual([
      { t: base * 1000, equityUsd: 470.12, dryRun: true },
      { t: (base + 1000) * 1000, equityUsd: 470.12, dryRun: true },
    ]);
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

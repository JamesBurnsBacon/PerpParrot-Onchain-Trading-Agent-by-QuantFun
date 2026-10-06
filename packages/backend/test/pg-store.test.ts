// Runs against a real Postgres when TEST_DATABASE_URL is set; see executor/test/pg-store.test.ts.
import { describe, expect, test } from "bun:test";
import { SQL } from "bun";
import { newBook } from "../src/paper/book";
import { PostgresEligibilityStore, PostgresPaperStore, PostgresSnapshotStore } from "../src/pg-store";

const url = process.env.TEST_DATABASE_URL;

// describe.skipIf still runs the describe body, so connect lazily.
describe.skipIf(!url)("PostgresSnapshotStore", async () => {
  if (!url) return;
  const sql = new SQL(url);
  await sql.unsafe(await Bun.file(new URL("../../../supabase/migrations/20261006120000_mirror.sql", import.meta.url)).text());
  const store = new PostgresSnapshotStore(sql);
  const runAt = 2_000_000_000 + Math.floor(Math.random() * 1e6) * 600;
  // Key order and spacing that jsonb would normalize away.
  const body = (n: number) => `{"snapshotId":"snap-${runAt}","configuration":{"configurationHash":"0x${"ab".repeat(32)}"},  "n":${n}}`;

  test("keeps the first body byte for byte and ignores later writes", async () => {
    expect(await store.get(runAt)).toBeUndefined();
    expect(await store.putIfAbsent(runAt, body(1))).toBe(body(1));
    expect(await store.putIfAbsent(runAt, body(2))).toBe(body(1));
    expect(await store.get(runAt)).toBe(body(1));
  });

  test("records the snapshot and configuration hashes", async () => {
    const [row] = await sql`select snapshot_hash, configuration_hash from run_snapshots where run_at = ${runAt}`;
    expect(row.configuration_hash).toBe(`0x${"ab".repeat(32)}`);
    expect(row.snapshot_hash).toMatch(/^0x[0-9a-f]{64}$/);
  });

  test("persists the eligible-asset list", async () => {
    const eligibility = new PostgresEligibilityStore(sql);
    const state = { assets: ["BTC", "ETH", "xyz:MSFT"], checkedAt: Date.parse("2026-10-07T00:01:00Z") };
    await eligibility.save(state);
    expect(await eligibility.load()).toEqual(state);
  });

  test("saves paper books and their equity points, only forward", async () => {
    const paper = new PostgresPaperStore(sql);
    const t = Date.now(); // past any lastRunAt a reused database holds
    const bookId = `test-${t}`;
    const book = { ...newBook(bookId, "test", "copy", 470, t), cashUsd: 461.25, feesUsd: 0.31, fundingUsd: -0.02, trades: 3 };
    book.positions = { BTC: { szi: 0.0012, entryPx: 121_234.5, markPx: 121_300 }, "xyz:NVDA": { szi: -0.75, entryPx: 187.31 } };
    const state = { books: [book], lastRunAt: t };
    expect(await paper.save(state, [{ bookId, t, equityUsd: 471.5 }])).toBe(true);
    expect(await paper.load()).toEqual(state); // exact round trip, doubles included
    // A second instance stepping the same run writes neither state nor points.
    expect(await paper.save({ books: [], lastRunAt: t }, [{ bookId, t: t + 1, equityUsd: 999 }])).toBe(false);
    expect(await paper.load()).toEqual(state);
    expect((await paper.points(t)).filter((p) => p.bookId === bookId)).toEqual([{ bookId, t, equityUsd: 471.5 }]);
  });
});

// Runs against a real Postgres when TEST_DATABASE_URL is set; see executor/test/pg-store.test.ts.
import { describe, expect, test } from "bun:test";
import { SQL } from "bun";
import { PostgresSnapshotStore } from "../src/pg-store";

const url = process.env.TEST_DATABASE_URL;

describe.skipIf(!url)("PostgresSnapshotStore", async () => {
  const sql = new SQL(url!);
  await sql.unsafe(await Bun.file(new URL("../../../supabase/migrations/20261006120000_cre_mirror.sql", import.meta.url)).text());
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
    const [row] = await sql`select snapshot_hash, configuration_hash from cre_snapshots where run_at = ${runAt}`;
    expect(row.configuration_hash).toBe(`0x${"ab".repeat(32)}`);
    expect(row.snapshot_hash).toMatch(/^0x[0-9a-f]{64}$/);
  });
});

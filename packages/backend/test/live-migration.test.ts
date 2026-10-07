import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { SQL } from "bun";

// Real Postgres (like the other store tests): runs when TEST_DATABASE_URL is set, as in CI.
describe.skipIf(!process.env.TEST_DATABASE_URL)("live usage migration", () => {
  let sql: SQL;
  const tag = "live-migration-test";
  const read = (name: string) => Bun.file(new URL(`../../../supabase/migrations/${name}`, import.meta.url)).text();
  beforeAll(async () => { sql = new SQL(process.env.TEST_DATABASE_URL!); });
  afterAll(async () => { await sql.unsafe(`delete from public.chat_usage where ip_hash = '${tag}'`); await sql.close(); });

  test("is idempotent, preserves chat rows and widens only the kind constraint", async () => {
    await sql.unsafe(await read("20261006140000_chat.sql"));
    await sql.unsafe(`insert into public.chat_usage (kind, ts_ms, ip_hash) values ('chat', 1, '${tag}')`);
    const migration = await read("20261007000000_live_usage.sql");
    await sql.unsafe(migration);
    await sql.unsafe(migration);
    await sql.unsafe(`insert into public.chat_usage (kind, ts_ms, ip_hash, cost_micro_usd) values ('live', 2, '${tag}', 300000)`);
    const rows = await sql.unsafe(`select kind from public.chat_usage where ip_hash = '${tag}' order by ts_ms`);
    expect(rows.map((r: { kind: string }) => r.kind)).toEqual(["chat", "live"]);
    let rejected = false;
    try { await sql.unsafe(`insert into public.chat_usage (kind, ts_ms, ip_hash) values ('trade', 3, '${tag}')`); } catch { rejected = true; }
    expect(rejected).toBe(true);
    const rls = await sql.unsafe("select relrowsecurity from pg_class where oid = 'public.chat_usage'::regclass");
    expect(rls[0].relrowsecurity).toBe(true);
  });
});

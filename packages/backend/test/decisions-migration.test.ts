import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { SQL } from "bun";
// Real PostgreSQL; offline runs skip without TEST_DATABASE_URL.
describe.skipIf(!process.env.TEST_DATABASE_URL)("decisions usage migration", () => {
  let sql: SQL;
  const tag = "decisions-migration-test";
  // Bun's SQL queries are lazy: `expect(query).rejects` never settles, so await inside try/catch.
  const rejects = async (run: () => Promise<unknown>) => { try { await run(); return false; } catch { return true; } };
  const read = (name: string) => Bun.file(new URL(`../../../supabase/migrations/${name}`, import.meta.url)).text();
  beforeAll(async () => { sql = new SQL(process.env.TEST_DATABASE_URL!); });
  afterAll(async () => { await sql`delete from public.chat_usage where ip_hash = ${tag}`; await sql.close(); });
  test("idempotent widening preserves rows, rejects other kinds and keeps RLS", async () => {
    await sql.unsafe(await read("20261006140000_chat.sql"));
    await sql.unsafe(await read("20261007000000_live_usage.sql"));
    await sql`insert into public.chat_usage (kind, ts_ms, ip_hash) values ('chat', 1, ${tag}), ('preview', 2, ${tag}), ('live', 3, ${tag})`;
    expect(await rejects(async () => { await sql`insert into public.chat_usage (kind, ts_ms, ip_hash) values ('decide', 4, ${tag})`; })).toBe(true);
    const migration = await read("20261008000000_decisions_usage.sql");
    await sql.unsafe(migration); await sql.unsafe(migration);
    await sql`insert into public.chat_usage (kind, ts_ms, ip_hash, cost_micro_usd) values ('decide', 4, ${tag}, 43)`;
    const rows = await sql`select kind from public.chat_usage where ip_hash = ${tag} order by ts_ms`;
    expect(rows.map((r: { kind: string }) => r.kind)).toEqual(["chat", "preview", "live", "decide"]);
    expect(await rejects(async () => { await sql`insert into public.chat_usage (kind, ts_ms, ip_hash) values ('trade', 5, ${tag})`; })).toBe(true);
    const rls = await sql`select relrowsecurity from pg_class where oid = 'public.chat_usage'::regclass`;
    expect(rls[0].relrowsecurity).toBe(true);
  });
});

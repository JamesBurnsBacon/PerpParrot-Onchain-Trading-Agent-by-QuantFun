import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { SQL } from "bun";
import { MemoryRequestStore, PostgresRequestStore } from "../src/chat/handler";
import type { StrategyIntent } from "../../shared/strategy-intent";

const intent: StrategyIntent = { riskStyle: "aggressive", maxSources: 10, diversification: "low", leverageComfort: "high", requestedLeverage: null, avoidClones: false, horizon: "medium", clarify: null, reply: "Squawk." };
const request = () => ({ id: crypto.randomUUID(), createdAtMs: Date.now(), previewHash: `0x${"ab".repeat(32)}`, intent, preview: { sources: ["source-a"], cashUnits: 100_000 } });

test("Postgres request store parameterizes pending preview JSON in one insert", async () => {
  const statements: { text: string; values: unknown[] }[] = [];
  const sql = (async (strings: TemplateStringsArray, ...values: unknown[]) => {
    statements.push({ text: strings.join("?").replace(/\s+/g, " ").trim(), values });
    return [];
  }) as unknown as SQL;
  const r = request();
  await new PostgresRequestStore(sql).save(r);
  expect(statements).toEqual([{
    text: "insert into public.strategy_requests (id, created_at_ms, preview_hash, intent, preview) values (?, ?, ?, ?::jsonb, ?::jsonb)",
    values: [r.id, r.createdAtMs, r.previewHash, JSON.stringify(r.intent), JSON.stringify(r.preview)],
  }]);
});

test("memory request store snapshots pending data and rejects duplicate IDs", async () => {
  const store = new MemoryRequestStore();
  const r = request();
  await store.save(r);
  r.preview.cashUnits = 123;
  expect(store.requests.get(r.id)).toEqual({ ...r, preview: { sources: ["source-a"], cashUnits: 100_000 }, status: "pending" });
  await expect(store.save(r)).rejects.toThrow();
});

describe.skipIf(!process.env.TEST_DATABASE_URL)("PostgresRequestStore", () => {
  let sql: SQL;
  beforeAll(async () => {
    sql = new SQL(process.env.TEST_DATABASE_URL!);
    const migration = await Bun.file(new URL("../../../supabase/migrations/20261006140000_chat.sql", import.meta.url)).text();
    await sql.unsafe(migration);
    await sql.unsafe(migration);
  });
  afterAll(async () => { await sql.close(); });
  test("exact JSON roundtrip, pending status and duplicate ID refusal", async () => {
    const r = request();
    const store = new PostgresRequestStore(sql);
    try {
      await store.save(r);
      const [row] = await sql`select * from public.strategy_requests where id = ${r.id}`;
      expect(row.id).toBe(r.id);
      expect(Number(row.created_at_ms)).toBe(r.createdAtMs);
      expect(row.preview_hash).toBe(r.previewHash);
      // Bun.SQL hands jsonb back as text; parse it before comparing.
      const parsed = (value: unknown) => typeof value === "string" ? JSON.parse(value) : value;
      expect(parsed(row.intent)).toEqual(r.intent);
      expect(parsed(row.preview)).toEqual(r.preview);
      expect(row.status).toBe("pending");
      await expect(store.save(r)).rejects.toThrow();
    } finally {
      await sql`delete from public.strategy_requests where id = ${r.id}`;
    }
  });
  test("RLS is enabled and public roles have no table privileges", async () => {
    for (const table of ["chat_usage", "strategy_requests"]) {
      const [row] = await sql`select relrowsecurity from pg_class where oid = ${`public.${table}`}::regclass`;
      expect(row.relrowsecurity).toBe(true);
      // Supabase roles exist only on Supabase; check the ones this database has (a plain Postgres has none).
      const roles = await sql`select rolname from pg_roles where rolname in ('anon', 'authenticated', 'service_role')`;
      const present = new Set(roles.map((r: { rolname: string }) => r.rolname));
      for (const role of ["anon", "authenticated"]) {
        if (!present.has(role)) continue;
        const [privilege] = await sql`select has_table_privilege(${role}, ${`public.${table}`}, 'SELECT,INSERT,UPDATE,DELETE') as allowed`;
        expect(privilege.allowed).toBe(false);
      }
      if (present.has("service_role")) {
        const [privilege] = await sql`select has_table_privilege('service_role', ${`public.${table}`}, 'SELECT,INSERT,UPDATE') as allowed`;
        expect(privilege.allowed).toBe(true);
      }
      // PUBLIC must have nothing either.
      const [open] = await sql`select count(*)::int as n from information_schema.table_privileges where table_schema = 'public' and table_name = ${table} and grantee = 'PUBLIC'`;
      expect(open.n).toBe(0);
    }
  });
});

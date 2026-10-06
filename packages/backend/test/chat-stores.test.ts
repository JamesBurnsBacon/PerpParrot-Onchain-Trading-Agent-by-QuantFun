import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { SQL } from "bun";
import { MemoryRequestStore, PostgresRequestStore } from "../src/chat/handler";
import type { StrategyIntent } from "../../shared/strategy-intent";

const intent: StrategyIntent = { riskStyle: "aggressive", maxSources: 10, diversification: "low", leverageComfort: "high", requestedLeverage: null, avoidClones: false, horizon: "medium", clarify: null, reply: "Squawk." };
const request = () => ({ id: crypto.randomUUID(), createdAtMs: Date.now(), previewHash: `0x${"ab".repeat(32)}`, intent, preview: { sources: ["source-a"], cashUnits: 100_000 } });

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
      expect(row.intent).toEqual(r.intent);
      expect(row.preview).toEqual(r.preview);
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
      for (const role of ["anon", "authenticated"]) {
        const [privilege] = await sql`select has_table_privilege(${role}, ${`public.${table}`}, 'SELECT,INSERT,UPDATE,DELETE') as allowed`;
        expect(privilege.allowed).toBe(false);
      }
      const [privilege] = await sql`select has_table_privilege('service_role', ${`public.${table}`}, 'SELECT,INSERT,UPDATE') as allowed`;
      expect(privilege.allowed).toBe(true);
    }
  });
});

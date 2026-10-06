import { expect, test } from "bun:test";
import { PGlite } from "@electric-sql/pglite";

test("live migration preserves chat rows and widens only the kind constraint", async () => {
  // Offline SQL coverage; real Postgres limiter cases still use TEST_DATABASE_URL.
  const db = new PGlite();
  try {
    await db.exec(await Bun.file(new URL("../../../supabase/migrations/20261006140000_chat.sql", import.meta.url)).text());
    await db.exec("insert into chat_usage (kind, ts_ms, ip_hash) values ('chat', 1, 'hashed-ip')");
    const migration = await Bun.file(new URL("../../../supabase/migrations/20261007000000_live_usage.sql", import.meta.url)).text();
    await db.exec(migration);
    await db.exec(migration);
    await db.exec("insert into chat_usage (kind, ts_ms, ip_hash, cost_micro_usd) values ('live', 2, 'hashed-ip', 300000)");
    expect((await db.query("select kind from chat_usage order by ts_ms")).rows).toEqual([{ kind: "chat" }, { kind: "live" }]);
    await expect(db.exec("insert into chat_usage (kind, ts_ms, ip_hash) values ('trade', 3, 'hashed-ip')")).rejects.toThrow();
    expect((await db.query("select relrowsecurity from pg_class where oid = 'public.chat_usage'::regclass")).rows).toEqual([{ relrowsecurity: true }]);
  } finally { await db.close(); }
});

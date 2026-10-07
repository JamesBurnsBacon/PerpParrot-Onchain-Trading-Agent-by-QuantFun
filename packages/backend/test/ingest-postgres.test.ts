// CI's existing Postgres service exercises Bun SQL and cross-connection locking.
// An isolated schema is created only when the operator supplies TEST_DATABASE_URL.
import {describe,expect,test} from 'bun:test';
import {SQL} from 'bun';
import {PgIngestStore,bunDatabase,type Database} from '../src/ingest/store';
const url=process.env.TEST_DATABASE_URL;
describe.skipIf(!url)('ingest over Bun SQL / real PostgreSQL',()=>{
  test('independent connections share claims and the 1200 weight budget',async()=>{
    const schema=`ingest_test_${crypto.randomUUID().replaceAll('-','')}`,legacy=`${schema}_legacy`;
    const sql=new SQL(url!,{max:4});
    const scoped=(db:Database):Database=>({query:(text,values)=>db.query(text.replaceAll('public.',`${schema}.`),values),
      transaction:fn=>db.transaction(tx=>fn(scoped(tx)))});
    try{
      await sql.unsafe(`create schema ${schema}`);
      const migration=(await Bun.file(new URL('../../../supabase/migrations/20261007110000_ingest_pipeline.sql',import.meta.url)).text())
        .replaceAll('public.',`${schema}.`).replaceAll("table_schema='public'",`table_schema='${schema}'`).replaceAll('ingest_legacy',legacy);
      await sql.unsafe(migration);
      const db=scoped(bunDatabase(sql)),a=new PgIngestStore(db),b=new PgIngestStore(db);
      const claims=await Promise.all([a.claimJob('refresh',1),b.claimJob('refresh',1)]);
      expect(claims.filter(Boolean)).toHaveLength(1);
      const results=await Promise.all(Array.from({length:70},(_,i)=>(i%2?a:b).reserve('info',20)));
      expect(results.filter(r=>r.id)).toHaveLength(60);
      const candidate={address:`0x${'a'.repeat(40)}`,knownHypercoreVault:false};
      await db.query("insert into public.ingest_accounts(address,candidate,last_seen) values($1,$2::jsonb,now())",[candidate.address,JSON.stringify(candidate)]);
      const accounts=await Promise.all([a.claimAccount('a',new Date().toISOString()),b.claimAccount('b',new Date().toISOString())]);
      expect(accounts.filter(Boolean)).toHaveLength(1);
    }finally{await sql.unsafe(`drop schema if exists ${schema} cascade; drop schema if exists ${legacy} cascade`);await sql.close();}
  },30_000);
});

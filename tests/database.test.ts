import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {PGlite} from '@electric-sql/pglite';
const hash='0x'+'c'.repeat(64);
async function init(path?:string){
 const db=new PGlite(path);await db.exec('create role anon; create role authenticated; create role service_role bypassrls;');
 for(const file of ['20261006120000_mirror.sql','20261006130000_review_audit.sql'])await db.exec(readFileSync(new URL(`../supabase/migrations/${file}`,import.meta.url),'utf8'));
 return db;
}
test('both migrations apply cleanly, and again (the mirror one is idempotent)',async()=>{
 const db=await init();try {
 await db.exec(readFileSync(new URL('../supabase/migrations/20261006120000_mirror.sql',import.meta.url),'utf8'));
 const tables=(await db.query<{tablename:string}>("select tablename from pg_tables where schemaname='public' order by 1")).rows.map(r=>r.tablename);
 assert.deepEqual(tables,['dashboard_artifacts','eligibility_state','executor_controls','executor_run_claims','executor_runs','paper_points','paper_state','review_audit','run_snapshots']);
 }finally{await db.close();}
});
test('audit persistence is idempotent and rejects content changes under the same identity',async()=>{
 const db=await init();try {
 const record={id:hash,snapshot_hash:hash,prompt_hash:hash,output_hash:hash,model_version:'pinned-model',prompt:{system:'fixed',evidence:{}},output:{results:[]},created_at_ms:1000};
 await db.query('select persist_review_audit($1::jsonb)',[JSON.stringify(record)]);
 await db.query('select persist_review_audit($1::jsonb)',[JSON.stringify(record)]);
 await assert.rejects(()=>db.query('select persist_review_audit($1::jsonb)',[JSON.stringify({...record,output:{results:[1]}})]),/conflicting/);
 assert.equal((await db.query('select * from review_audit')).rows.length,1);
 }finally{await db.close();}
});

test('the rename migration moves a database created before 2026-10-07 to the current names, idempotently',async()=>{
 const db=new PGlite();try{
  await db.exec('create role anon;');
  // The pre-2026-10-07 shape (only what the rename touches).
  await db.exec(`create table cre_snapshots (run_at bigint primary key, body text not null);
   create table cre_eligibility (id smallint primary key);
   create table executor_reports (report_id text primary key);
   create table executor_runs (id text primary key, kind text not null check (kind in ('report','flatten')), envelope jsonb);
   create table executor_order_batches (id text primary key, report_id text not null);
   alter table cre_snapshots enable row level security;
   create policy cre_snapshots_public_read on cre_snapshots for select to anon using (true);
   insert into executor_runs values ('r1','report','{"report":"ab"}'), ('f1','flatten',null);
   insert into executor_reports values ('k1'); insert into executor_order_batches values ('b1','k1');`);
  const sql=readFileSync(new URL('../supabase/migrations/20261007090000_rename_mirror_tables.sql',import.meta.url),'utf8');
  await db.exec(sql);await db.exec(sql);
  const tables=(await db.query<{tablename:string}>("select tablename from pg_tables where schemaname='public' order by 1")).rows.map(r=>r.tablename);
  assert.deepEqual(tables,['eligibility_state','executor_order_batches','executor_run_claims','executor_runs','run_snapshots']);
  assert.deepEqual((await db.query("select id,kind,evidence from executor_runs order by id")).rows,[{id:'f1',kind:'flatten',evidence:null},{id:'r1',kind:'mirror',evidence:{report:'ab'}}]);
  assert.deepEqual((await db.query('select run_id from executor_run_claims')).rows,[{run_id:'k1'}]);
  assert.deepEqual((await db.query('select run_id from executor_order_batches')).rows,[{run_id:'k1'}]);
  assert.deepEqual((await db.query("select policyname from pg_policies where tablename='run_snapshots'")).rows,[{policyname:'run_snapshots_public_read'}]);
  await assert.rejects(db.exec("insert into executor_runs values ('r2','report',null)"));
 }finally{await db.close();}
});

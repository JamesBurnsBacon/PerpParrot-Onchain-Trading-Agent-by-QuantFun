import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {PGlite} from '@electric-sql/pglite';
const hash='0x'+'c'.repeat(64);
async function init(path?:string){
 const db=new PGlite(path);await db.exec('create role anon; create role authenticated; create role service_role bypassrls;');
 for(const file of ['20261006120000_cre_mirror.sql','20261006130000_review_audit.sql','20261006180000_executor_order_journal.sql'])await db.exec(readFileSync(new URL(`../supabase/migrations/${file}`,import.meta.url),'utf8'));
 return db;
}
test('CRE, audit and execution-journal migrations apply cleanly and idempotently',async()=>{
 const db=await init();try {
 for(const file of ['20261006120000_cre_mirror.sql','20261006180000_executor_order_journal.sql'])await db.exec(readFileSync(new URL(`../supabase/migrations/${file}`,import.meta.url),'utf8'));
 const tables=(await db.query<{tablename:string}>("select tablename from pg_tables where schemaname='public' order by 1")).rows.map(r=>r.tablename);
 assert.deepEqual(tables,['cre_eligibility','cre_snapshots','executor_controls','executor_order_batches','executor_reports','executor_runs','review_audit']);
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

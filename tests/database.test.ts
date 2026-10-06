import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {PGlite} from '@electric-sql/pglite';
const account='0x'+'a'.repeat(40),signer='0x'+'b'.repeat(40),hash='0x'+'c'.repeat(64);
async function init(path?:string){const db=new PGlite(path);await db.exec('create role anon; create role authenticated; create role service_role bypassrls;');await db.exec(readFileSync(new URL('../packages/backend/migrations/001_execution_state.sql',import.meta.url),'utf8'));return db;}
async function claim(db:PGlite,run='run:1',report=hash,now=1000){return (await db.query<{value:{claimed:boolean;nonce:number;state:string}}>('select claim_preview($1,$2,$3,$4,$5,$6) as value',[999,account,run,report,signer,now])).rows[0].value;}
test('PostgreSQL claims serialize account intent, bind replays, and allocate persistent signer nonces',async()=>{
 const db=await init();try {
 const first=await claim(db);assert.equal(first.claimed,true);assert.equal(first.nonce,1000);
 assert.equal((await claim(db)).claimed,false);
 await assert.rejects(()=>db.query('select claim_preview($1,$2,$3,$4,$5,$6)',[999,account,'run:1',hash,'0x'+'e'.repeat(40),1000]),/conflicting/);
 await assert.rejects(()=>claim(db,'run:1','0x'+'d'.repeat(64)),/conflicting/);
 await assert.rejects(()=>claim(db,'run:2'),/unreconciled/);
 await db.query('select finish_preview($1,$2,$3,$4,$5::jsonb)',[999,account,'run:1',hash,JSON.stringify({mode:'PREVIEW'})]);
 assert.equal((await claim(db,'run:2')).nonce,1001);
 await db.exec('set role authenticated');
 await assert.rejects(()=>db.query('select * from preview_runs'),/permission denied/);
 await assert.rejects(()=>claim(db),/permission denied/);
 }finally{await db.close();}
});
test('durable PostgreSQL intent survives restart and uncertain state blocks later runs',async()=>{
 const path=mkdtempSync(join(tmpdir(),'perpparrot-pg-'));let db=await init(path);
 try {
 await claim(db);await db.query('select mark_preview_unknown($1,$2,$3,$4)',[999,account,'run:1',hash]);await db.close();
 db=new PGlite(path);assert.equal((await claim(db)).state,'UNKNOWN');await assert.rejects(()=>claim(db,'run:2'),/unreconciled/);
 }finally{await db.close();rmSync(path,{recursive:true,force:true});}
});
test('two consecutive failures persist one alert atomically; duplicate outcomes cannot reset newer health',async()=>{
 const db=await init();try{
 for(const [slot,success] of [[10,false],[11,false],[11,true],[12,false]] as const)await db.query('select record_mirror_health($1,$2,$3)',['mirror',slot,success]);
 const health=(await db.query<{last_slot:number;failures:number}>('select * from mirror_health')).rows[0];
 assert.equal(Number(health.last_slot),12);assert.equal(Number(health.failures),3);
 assert.equal((await db.query('select * from alert_outbox')).rows.length,1);
 await db.query('select record_mirror_health($1,$2,$3)',['mirror',13,true]);
 assert.equal(Number((await db.query<{failures:number}>('select * from mirror_health')).rows[0].failures),0);
 }finally{await db.close();}
});
test('alert leases survive competing workers and only the lease owner can acknowledge',async()=>{
 const db=await init();try{
 await db.query('select record_mirror_health($1,$2,$3)',['mirror',10,false]);await db.query('select record_mirror_health($1,$2,$3)',['mirror',11,false]);
 const lease='11111111-1111-4111-8111-111111111111',other='22222222-2222-4222-8222-222222222222';
 const first=(await db.query<{value:{id:string}}>('select claim_alert($1,$2) as value',[lease,1000])).rows[0].value;
 assert.ok(first.id);assert.equal((await db.query<{value:unknown}>('select claim_alert($1,$2) as value',[other,1001])).rows[0].value,null);
 assert.equal((await db.query<{value:boolean}>('select ack_alert($1,$2,$3) as value',[first.id,other,1001])).rows[0].value,false);
 assert.equal((await db.query<{value:boolean}>('select ack_alert($1,$2,$3) as value',[first.id,lease,1001])).rows[0].value,true);
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

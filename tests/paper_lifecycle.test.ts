import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {PGlite} from '@electric-sql/pglite';
import {reviewPaperSession,freezePaperSession} from '../packages/backend/review/paper/lifecycle.ts';
import {SupabasePaperStore} from '../packages/backend/review/paper/store.ts';
import {runCommitteeReview} from '../packages/backend/review/committee/workflow.ts';
import {paperFixture,NOW} from './support/paper-lifecycle-fixture.ts';
import type {Rpc} from '../packages/backend/review/supabase.ts';
async function database(path?:string):Promise<PGlite>{const db=new PGlite(path);await db.exec('create role anon; create role authenticated; create role service_role bypassrls;');for(const name of ['20261006130000_review_audit.sql','20261006140000_paper_review.sql'])await db.exec(readFileSync(new URL('../supabase/migrations/'+name,import.meta.url),'utf8'));return db;}
function transport(db:()=>PGlite):Rpc{return {async call(name,args){if(!/^[a-z_]+$/.test(name))throw new Error('invalid RPC');const keys=Object.keys(args);return (await db().query<{value:unknown}>(`select ${name}(${keys.map((key,i)=>`${key} => $${i+1}`).join(',')}) as value`,Object.values(args).map(v=>typeof v==='object'?JSON.stringify(v):v))).rows[0].value;}};}
const noMonitor=async ():Promise<never>=>{throw new Error('monitor not expected');};
test('rich review and paper freeze survive restart and enforce monitoring-only afterward',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'perpparrot-review-'));let db=await database(dir);const rpc=transport(()=>db),store=new SupabasePaperStore(rpc),f=paperFixture(rpc);
 try {
 const result=await reviewPaperSession(f.input,store,f.deps,noMonitor);if(result.phase!=='REVIEW')throw Error('unexpected phase');
 assert.equal(result.receipt.manifest.status,'VALID');assert.equal(result.receipt.auditIds.length,6);
 const frozen=await freezePaperSession(store,f.input.session,result.receipt.receiptHash,f.account,f.chainId,NOW);assert.equal(frozen.reviewHash,result.receipt.receiptHash);
 assert.equal(frozen.policy.bucket,'AGGRESSIVE');
 await db.close();db=new PGlite(dir);const restarted=new SupabasePaperStore(rpc);
 assert.equal((await restarted.load(f.input.session)).configuration?.configurationHash,frozen.configurationHash);
 assert.equal((await reviewPaperSession(f.input,restarted,f.deps,async evidence=>({evidenceHash:evidence.evidenceHash,concerns:[]}))).phase,'MONITOR');assert.equal(f.modelCalls(),3);
 assert.equal((await reviewPaperSession(f.input,restarted,f.deps,async()=>{throw Error('cached monitor must not call model');})).phase,'MONITOR');
 const changed={...f.input,rich:structuredClone(f.input.rich)};const patterns=changed.rich.finalists[0].patterns;patterns.observedFills=(patterns.observedFills??0)+1;
 await assert.rejects(()=>reviewPaperSession(changed,restarted,f.deps,async evidence=>({evidenceHash:evidence.evidenceHash,concerns:[],weights:[1]})));
 await assert.rejects(()=>restarted.review(f.input.session,result.receipt),/frozen/);
 const drafts=(await db.query<{prompt:{draft?:unknown}}>("select prompt from review_audit where output ? 'draftHash'")).rows;assert.equal(drafts.length,2);assert.ok(drafts.every(record=>record.prompt.draft));
 await db.exec('set role authenticated');await assert.rejects(()=>db.query('select * from paper_sessions'),/permission denied/);
 }finally{await db.close();rmSync(dir,{recursive:true,force:true});}
});
test('unbound specialist response or unavailable audit cannot produce a valid review',async()=>{
 const db=await database();try{
 const rpc=transport(()=>db),f=paperFixture(rpc),role=f.deps.role;
 f.deps.role=async(e,s)=>(await role(e,s)).map(row=>({...row,evidenceHash:'0x'+'f'.repeat(64)}));
 assert.equal((await runCommitteeReview(f.input.frame,f.input.policy,f.input.addresses,f.input.rich,NOW,f.deps)).manifest.status,'INVALID_BUCKET');
 f.deps.role=role;f.deps.audit=async()=>{throw Error('database unavailable');};assert.equal((await runCommitteeReview(f.input.frame,f.input.policy,f.input.addresses,f.input.rich,NOW,f.deps)).manifest.status,'INVALID_BUCKET');
 }finally{await db.close();}
});
test('paper pause is durable and identity-bound while monitoring remains read-only',async()=>{
 const db=await database();try{
 const rpc=transport(()=>db),store=new SupabasePaperStore(rpc),f=paperFixture(rpc),review=await reviewPaperSession(f.input,store,f.deps,noMonitor);if(review.phase!=='REVIEW')throw Error('unexpected phase');
 const frozen=await freezePaperSession(store,f.input.session,review.receipt.receiptHash,f.account,999,NOW);await store.pause(f.input.session,frozen.configurationHash,true);assert.equal((await store.load(f.input.session)).paused,true);
 await assert.rejects(()=>store.pause(f.input.session,'0x'+'f'.repeat(64),false),/unknown/);
 assert.equal((await reviewPaperSession(f.input,store,f.deps,async evidence=>({evidenceHash:evidence.evidenceHash,concerns:[]}))).phase,'MONITOR');
 await store.pause(f.input.session,frozen.configurationHash,false);assert.equal((await store.load(f.input.session)).paused,false);
 }finally{await db.close();}
});

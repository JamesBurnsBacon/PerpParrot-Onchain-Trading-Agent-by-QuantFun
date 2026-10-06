import {test,expect} from 'bun:test';
import {PGlite} from '@electric-sql/pglite';
import {mkdtempSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {paperFixture,NOW} from '../tests/support/paper-lifecycle-fixture.ts';
import {SupabasePaperStore} from '../packages/backend/review/paper/store.ts';
import {reviewPaperSession,freezePaperSession} from '../packages/backend/review/paper/lifecycle.ts';
import type {Rpc} from '../packages/backend/review/supabase.ts';
import {measuredSessionId} from './measured-review.ts';
import {providerSessionId,MODELS} from './provider-probe.ts';

test('actual measured/provider session IDs survive SQL review, freeze and database reopen',async()=>{
 const directory=mkdtempSync(join(tmpdir(),'measured-paper-sessions-'));let db=new PGlite(directory);
 const rpc:Rpc={async call(name,args){
  if(!/^[a-z_]+$/.test(name)||Object.keys(args).some(k=>!/^[a-z_]+$/.test(k)))throw Error('INVALID_RPC');
  return(await db.query<{value:unknown}>(`select ${name}(${Object.keys(args).map((key,i)=>`${key} => $${i+1}`).join(',')}) as value`,Object.values(args).map(v=>typeof v==='object'?JSON.stringify(v):v))).rows[0].value;
 }};
 try{
  await db.exec('create role anon; create role authenticated; create role service_role bypassrls;');
  for(const file of ['20261006130000_review_audit.sql','20261006140000_paper_review.sql'])await db.exec(readFileSync(new URL('../supabase/migrations/'+file,import.meta.url),'utf8'));
  const fixture=paperFixture(rpc),hash=fixture.input.frame.snapshotHash;
  const sessions=[measuredSessionId('return-first',hash),measuredSessionId('drawdown-first',hash),...MODELS.map(model=>providerSessionId(model,hash))];
  expect(new Set(sessions).size).toBe(4);expect(sessions.every(id=>/^[0-9a-f]{64}$/.test(id))).toBe(true);
  let store=new SupabasePaperStore(rpc);
  for(const session of sessions){
   const result=await reviewPaperSession({...fixture.input,session},store,fixture.deps,async()=>{throw Error('unexpected monitor');});
   expect(result.phase).toBe('REVIEW');if(result.phase!=='REVIEW')throw Error('unexpected phase');
   expect(result.receipt.manifest.status).toBe('VALID');
   const frozen=await freezePaperSession(store,session,result.receipt.receiptHash,fixture.account,999,NOW);
   expect((await store.load(session)).configuration?.configurationHash).toBe(frozen.configurationHash);
  }
  // Regression control: the former literal prefix + full frame hash is rejected by the actual migration.
  await expect(store.load('provider:'+MODELS[0]+':'+hash)).rejects.toThrow('paper_sessions_id_check');
  await expect(store.load('measured:return-first:'+hash)).rejects.toThrow('paper_sessions_id_check');
  await db.close();db=new PGlite(directory);store=new SupabasePaperStore(rpc);
  for(const session of sessions){const saved=await store.load(session);expect(saved.review?.manifest.status).toBe('VALID');expect(saved.configuration?.reviewHash).toBe(saved.review?.receiptHash);}
 }finally{await db.close();rmSync(directory,{recursive:true,force:true});}
},60_000);

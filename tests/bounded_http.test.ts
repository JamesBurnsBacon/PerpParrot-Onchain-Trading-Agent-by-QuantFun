import {test} from 'node:test';
import assert from 'node:assert/strict';
import {postJson} from '../packages/shared/src/bounded-http.ts';
import {openAIPaperCommittee} from '../packages/backend/review/models/openai-paper.ts';
import {bindCommitteeEvidence} from '../packages/shared/src/committee-evidence.ts';
import {paperFixture} from './support/paper-lifecycle-fixture.ts';

test('bounded HTTP validates explicit deadline and honours cancellation without retries',async()=>{
 let calls=0;
 const pending=(async(_url:unknown,init?:RequestInit)=>{calls++;return await new Promise<Response>((_resolve,reject)=>{
  init!.signal!.addEventListener('abort',()=>reject(new Error('test aborted')),{once:true});
 });}) as unknown as typeof fetch;
 const keepAlive=setTimeout(()=>{},1000);
 try{
  await assert.rejects(postJson('https://test.invalid',{}, {},new AbortController().signal,pending,20),/test aborted/);
  assert.equal(calls,1);
  for(const timeout of [0,60001,NaN,1.5])await assert.rejects(postJson('https://test.invalid',{}, {},new AbortController().signal,pending,timeout),/invalid upstream deadline/);
  assert.equal(calls,1);
  const controller=new AbortController();const promise=postJson('https://test.invalid',{}, {},controller.signal,pending,60000);controller.abort();
  await assert.rejects(promise,/test aborted/);assert.equal(calls,2);
 }finally{clearTimeout(keepAlive);}
});
test('model transport uses existing committee deadline instead of an independent 10-second cap',async()=>{
 const f=paperFixture({async call(){return null;}}),evidence=bindCommitteeEvidence(f.input.frame,f.input.policy,f.input.addresses,f.input.rich);
 const original=AbortSignal.timeout,deadlines:number[]=[];
 // Inspect allocation of the bound only; no waiting or external provider requests.
 AbortSignal.timeout=function(milliseconds:number){deadlines.push(milliseconds);return original.call(AbortSignal,milliseconds);};
 try{
  const deps=openAIPaperCommittee({apiKey:'local-test-only',model:'gpt-4.1-mini-2025-04-14',fetcher:(async()=>new Response('{}',{status:401})) as unknown as typeof fetch},
   {...f.deps,agentTimeoutMs:60000});
  await assert.rejects(deps.role(evidence,new AbortController().signal),/upstream request failed/);
  assert.deepEqual(deadlines,[60000]);
  assert.throws(()=>openAIPaperCommittee({apiKey:'local-test-only',model:'gpt-4.1-mini-2025-04-14'},{...f.deps,agentTimeoutMs:60001}),/invalid paper model configuration/);
 }finally{AbortSignal.timeout=original;}
});

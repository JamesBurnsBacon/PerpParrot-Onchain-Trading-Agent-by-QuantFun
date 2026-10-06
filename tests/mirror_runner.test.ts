import {test} from 'node:test';
import assert from 'node:assert/strict';
import {runPaperMirror} from '../packages/cre-workflows/mirror/runner.ts';
import type {PaperMirrorAdapters, PaperMirrorRun} from '../packages/cre-workflows/mirror/runner.ts';
import {fixture} from './support/mirror-fixture.ts';
function setup() {
  const f=fixture();
  const input: PaperMirrorRun={configuration:f.configuration,sampleSeed:'0x'+'c'.repeat(64),markets:f.markets,runId:f.runId,maxStateAgeMs:f.maxStateAgeMs,deadlineMs:1000};
  const calls: string[]=[];
  const adapters: PaperMirrorAdapters={
    async confirmedFreeze() {return f.confirmedFreeze;},
    async snapshot() {calls.push('snapshot');return f.snapshot;},
    async account(address) {
      calls.push(address);
      return address===f.account.address ? f.account : f.checks.find(state=>state.address===address)!;
    },
  };
  return {f,input,calls,adapters};
}
test('paper runner integrates complete independent checks and preserves input', async()=>{
  const {f,input,calls,adapters}=setup(), before=structuredClone(input);
  const result=await runPaperMirror(input,adapters,()=>f.nowMs);
  assert.equal(result.status,'READY');
  assert.equal(calls.length,7); // one snapshot, own account, five sources
  assert.equal(new Set(calls).size,calls.length);
  assert.deepEqual(input,before);
  if(result.status==='READY') assert.equal(result.plan.mode,'PAPER');
});
test('adapter failure holds with no fallback and no credential echo',async()=>{
  const {f,input,adapters}=setup();
  adapters.snapshot=async()=>{throw new Error('Bearer secret');};
  assert.deepEqual(await runPaperMirror(input,adapters,()=>f.nowMs),{status:'HOLD',reason:'mirror fetch, validation, or deadline failed'});
});
test('hung adapters hit deadline and receive cancellation',async()=>{
  const {f,input,adapters}=setup();input.deadlineMs=10;
  let signal: AbortSignal | undefined;
  adapters.snapshot=async(s)=>{signal=s;return new Promise(()=>{});};
  const result=await runPaperMirror(input,adapters,()=>f.nowMs);
  assert.equal(result.status,'HOLD');assert.equal(signal?.aborted,true);
});
test('stale fetched state and backward clocks hold',async()=>{
  const {f,input,adapters}=setup();
  f.account.observedAtMs=0;
  assert.equal((await runPaperMirror(input,adapters,()=>f.nowMs)).status,'HOLD');
  let count=0;
  assert.equal((await runPaperMirror(input,adapters,()=>count++===0 ? 3000 : 2999)).status,'HOLD');
});

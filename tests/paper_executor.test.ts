import {test} from 'node:test';
import assert from 'node:assert/strict';
import {fixture} from './support/mirror-fixture.ts';
import {buildMirrorPlan} from '../packages/cre-workflows/mirror/core.ts';
import {createPaperReport} from '../packages/shared/src/paper-report.ts';
import {PaperExecutor} from '../packages/executor/src/paper.ts';
import {commitment} from '../packages/shared/src/commitments.ts';
function setup(){const input=fixture(),result=buildMirrorPlan(input);if(result.status!=='READY')throw new Error(result.reason);return {input,report:createPaperReport(result.plan,input.configuration,input.nowMs)};}
test('paper executor independently rebuilds and applies deltas with idempotent isolated receipts',()=>{
  const {input,report}=setup(),executor=new PaperExecutor();
  const receipt=executor.execute(report,input,input.nowMs);
  assert.deepEqual(receipt.positions,[{market:'BTC',notionalMicros:'600000000'}]);
  receipt.positions[0].notionalMicros='1';
  assert.equal(executor.execute(report,input,input.nowMs).positions[0].notionalMicros,'600000000');
  assert.deepEqual(input.account.positions,[]);
});
test('tampering, foreign authority, live mode, and stale reports reject',()=>{
  for(const modify of [(r:any)=>r.plan.deltas[0].notionalMicros='1',(r:any)=>r.chainId=1,(r:any)=>r.mode='LIVE',(r:any)=>r.extra=true]){
    const {input,report}=setup();modify(report);
    assert.throws(()=>new PaperExecutor().execute(report,input,input.nowMs));
  }
  const {input,report}=setup();assert.throws(()=>new PaperExecutor().execute(report,input,report.plan.expiresAtMs));
});
test('recomputed attacker hashes cannot replace independently rebuilt evidence',()=>{
  const {input,report}=setup();report.plan.deltas[0].notionalMicros='1';
  const {planHash:_,...plan}=report.plan;report.plan.planHash=commitment('perpparrot:mirror-plan:v1',plan);
  const {reportHash:__,...payload}=report;report.reportHash=commitment('perpparrot:paper-report:v1',payload);
  assert.throws(()=>new PaperExecutor().execute(report,input,input.nowMs));
});
test('same run identity with different validated evidence rejects replay',()=>{
  const {input,report}=setup(),executor=new PaperExecutor();executor.execute(report,input,input.nowMs);
  input.account.positions=[{market:'BTC',notionalMicros:'100000000'}];
  const result=buildMirrorPlan(input);assert.equal(result.status,'READY');if(result.status!=='READY')return;
  const changed=createPaperReport(result.plan,input.configuration,input.nowMs);
  assert.throws(()=>executor.execute(changed,input,input.nowMs),/conflicting/);
});

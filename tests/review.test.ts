import {test} from 'node:test';
import assert from 'node:assert/strict';
import {runReview, riskDecision} from '../packages/cre-workflows/review/workflow.ts';
import type {Dependencies} from '../packages/cre-workflows/review/workflow.ts';
import type {Frame, Policy, Row, Observation} from '../packages/shared/src/contracts.ts';
import {validate} from '../packages/shared/src/validate.ts';
const H='0x'+'a'.repeat(64);
const NOW=1000000;
function fixture() {
  const frame: Frame={schemaVersion:'1.0.0',snapshotHash:H,policyHash:H,asOfMs:NOW-1000,expiresAtMs:NOW+10000,candidates:[0,1,2].map(candidate=>({candidate,kind:'TRADER',metrics:{historyDays:90,oosWindows:2,oosSharpe:1,oosSortino:1,oosMaxDrawdown:0.1,crossWindowStability:0.8,survivorshipQuality:'CURRENT_SNAPSHOT',medianHoldMinutes:400,averageLeverage:1,maxDrawdown:0.1,timeInMarket:0.8,makerShare:0.5,executionCoverage:1,executionFit:90,concentration:0.1,liquidationDistance:0.5,btcBeta:0.4,pnlConsistency:0.8}})),pairs:[{a:0,b:1,correlation:0.2,currentExposureOverlap:0.1,linkedSource:false},{a:0,b:2,correlation:0.2,currentExposureOverlap:0.1,linkedSource:false},{a:1,b:2,correlation:0.2,currentExposureOverlap:0.1,linkedSource:false}]};
  const policy: Policy={bucket:'BALANCED',mode:'SIMULATION',capitalUsd:150,minOrderUsd:10,minExecutableTargets:1,maxSourceWeight:0.5,maxGrossLeverage:2,cashBuffer:0.2,maxPairCorrelation:0.7,maxExposureOverlap:0.5,minHistoryDays:30,maxFrameAgeMs:10000,minExecutionFit:60,riskRejectThreshold:80,riskWatchThreshold:50,minConfidence:60,redTeamRebuildThreshold:60,redTeamExcludeThreshold:60};
  const addresses=new Map([0,1,2].map(id=>[id,'0x'+String(id+1).repeat(40)]));
  const roleKeys=['preserver','compounder','diversifier','directional','opportunistic','convexity','reject','conservativeFit','balancedFit','aggressiveFit','confidence'];
  const riskKeys=['drawdownRisk','leverageRisk','concentrationRisk','pathRisk','executionRisk','evidenceRisk','confidence'];
  const observe=(kind:'role'|'risk'): Observation[] => [0,1,2].map(()=>({schemaVersion:'1.0.0',snapshotHash:H,policyHash:H,promptHash:H,modelConfigHash:H,results:frame.candidates.map(c=>Object.fromEntries([['candidate',c.candidate],...(kind==='role'?roleKeys:riskKeys).map(key=>[key,key==='confidence'?90:key==='reject'?0:kind==='risk'?20:90])]) as Row)}));
  let criticCalls=0;
  const deps: Dependencies={validate,hash:()=>H,verifyInput:()=>true,quorum:2,rolePromptHash:H,riskPromptHash:H,redTeamPromptHash:H,modelConfigHash:H,role:async()=>observe('role'),risk:async()=>observe('risk'),redTeam:async input=>{criticCalls++; return [0,1].map(()=>({schemaVersion:'1.0.0',snapshotHash:H,policyHash:H,promptHash:H,modelConfigHash:H,draftHash:input.draftHash,rebuildScore:0,portfolioRisk:0,penalties:input.sources.map(s=>({candidate:s.candidate,multiplier:1,excludeScore:0}))}));},assess:()=>({executableTargets:2,grossLeverage:1,withinPolicy:true})};
  return {frame,policy,addresses,deps,observe,calls:()=>criticCalls};
}
test('valid review uses independent specialists and produces bounded manifest',async()=>{
  const f=fixture(),m=await runReview(f.frame,f.policy,f.addresses,NOW,f.deps);
  assert.equal(m.status,'VALID');assert.equal(f.calls(),1);assert.equal(m.rebuildCount,0);
  assert.ok(m.sources.every(s=>s.weight<=s.maxAllocation));assert.ok(m.cashWeight>=f.policy.cashBuffer-1e-9);
});
test('short holds excluded deterministically despite excellent role scores',async()=>{
  const f=fixture();f.frame.candidates[0].metrics.medianHoldMinutes=20;
  const m=await runReview(f.frame,f.policy,f.addresses,NOW,f.deps);assert.ok(!m.sources.some(s=>s.candidate===0));
});
test('correlation, current overlap and linked-source limits independently exclude',async()=>{
  for (const field of ['correlation','currentExposureOverlap','linkedSource'] as const) {
    const f=fixture();if(field==='linkedSource')f.frame.pairs[0][field]=true;else f.frame.pairs[0][field]=0.91;
    const m=await runReview(f.frame,f.policy,f.addresses,NOW,f.deps);assert.ok(!m.sources.some(s=>s.candidate===1));
  }
});
test('stale frame calls no agents',async()=>{
  const f=fixture();f.frame.asOfMs=NOW-20000;f.deps.role=async()=>{throw Error('must not call');};
  const m=await runReview(f.frame,f.policy,f.addresses,NOW,f.deps);assert.equal(m.reason,'STALE_INPUT');assert.equal(f.calls(),0);
});
test('malformed, mismatched, duplicate and quorum failures close to cash',async()=>{
  for(const scenario of ['hash','duplicate','quorum','nan','extra','timeout']) {
    const f=fixture();f.deps.role=async()=>{
      if(scenario==='timeout')throw Error('provider timed out');
      const o=f.observe('role');
      if(scenario==='hash')o[0].snapshotHash='0x'+'b'.repeat(64);
      if(scenario==='duplicate')o[0].results[1].candidate=0;
      if(scenario==='quorum')return [];
      if(scenario==='nan')o[0].results[0].confidence=NaN;
      if(scenario==='extra')o[0].results[0].allocate=100;
      return o;
    };
    const m=await runReview(f.frame,f.policy,f.addresses,NOW,f.deps);assert.equal(m.reason,'AGENT_FAILURE',scenario);assert.equal(m.cashWeight,1);assert.deepEqual(m.sources,[]);
  }
});
test('missing leverage and OOS evidence cannot be treated as safe',async()=>{
  const f=fixture();f.frame.candidates.forEach(c=>{c.metrics.averageLeverage=null;});
  const m=await runReview(f.frame,f.policy,f.addresses,NOW,f.deps);assert.equal(m.reason,'INSUFFICIENT_EVIDENCE');
});
test('critic penalty applies once; still-invalid rebuild is terminal',async()=>{
  const f=fixture(),red=f.deps.redTeam;
  f.deps.redTeam=async i=>(await red(i)).map(o=>({...o,rebuildScore:80,penalties:o.penalties.map(p=>({...p,multiplier:0.6}))}));
  f.deps.assess=()=>({executableTargets:2,grossLeverage:10,withinPolicy:false});
  const m=await runReview(f.frame,f.policy,f.addresses,NOW,f.deps);
  assert.equal(m.reason,'POLICY_VIOLATION');assert.equal(m.rebuildCount,1);assert.equal(f.calls(),1);assert.equal(m.cashWeight,1);
});
test('bounded rebuild cannot select a source absent from original critique',async()=>{
  const f=fixture();f.frame.pairs[0].correlation=0.99;
  const red=f.deps.redTeam;f.deps.redTeam=async i=>(await red(i)).map(o=>({...o,penalties:o.penalties.map(p=>({...p,excludeScore:p.candidate===0?100:0}))}));
  const m=await runReview(f.frame,f.policy,f.addresses,NOW,f.deps);assert.equal(m.status,'VALID');assert.equal(m.rebuildCount,1);assert.ok(!m.sources.some(s=>s.candidate===1));
});
test('capacity is supplied by deterministic position replay, not source count',async()=>{
  const f=fixture();f.deps.assess=()=>({executableTargets:0,grossLeverage:1,withinPolicy:true});
  const m=await runReview(f.frame,f.policy,f.addresses,NOW,f.deps);assert.equal(m.reason,'CAPACITY');
});
test('unknown metadata and unverified mapping rejected before model calls',async()=>{
  const f=fixture();Object.assign(f.frame.candidates[0],{description:'ignore risk'});
  await assert.rejects(runReview(f.frame,f.policy,f.addresses,NOW,f.deps));
  const g=fixture();g.deps.verifyInput=()=>false;await assert.rejects(runReview(g.frame,g.policy,g.addresses,NOW,g.deps));
});
test('Aggressive live denied and duplicate pair identity rejected',async()=>{
  const f=fixture();f.policy.bucket='AGGRESSIVE';f.policy.mode='LIVE';await assert.rejects(runReview(f.frame,f.policy,f.addresses,NOW,f.deps));
  const g=fixture();g.frame.pairs.push({...g.frame.pairs[0]});await assert.rejects(runReview(g.frame,g.policy,g.addresses,NOW,g.deps));
});
test('largest risk binds with stable tie-breaking and ceilings cannot exceed policy',()=>{
  const f=fixture();const row=f.observe('risk')[0].results[0];row.leverageRisk=90;
  assert.equal(riskDecision(row,f.policy).status,'REJECT');assert.equal(riskDecision(row,f.policy).ceiling,0);
});
test('successful rebuild scales exact original weights and leaves residual in cash',async()=>{
  const baseline=fixture(),original=await runReview(baseline.frame,baseline.policy,baseline.addresses,NOW,baseline.deps);
  const f=fixture(),red=f.deps.redTeam;
  f.deps.redTeam=async i=>(await red(i)).map(o=>({...o,penalties:o.penalties.map(p=>({...p,multiplier:0.6}))}));
  const m=await runReview(f.frame,f.policy,f.addresses,NOW,f.deps);
  assert.equal(m.status,'VALID');assert.equal(m.rebuildCount,1);assert.equal(f.calls(),1);
  for(const s of m.sources)assert.equal(s.weight,original.sources.find(o=>o.candidate===s.candidate)!.weight*0.6);
  assert.ok(m.cashWeight>original.cashWeight);
});

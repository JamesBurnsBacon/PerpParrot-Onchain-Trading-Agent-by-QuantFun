import {test} from 'node:test';
import assert from 'node:assert/strict';
import {runReview, riskDecision} from '../packages/cre-workflows/review/workflow.ts';
import type {Dependencies} from '../packages/cre-workflows/review/workflow.ts';
import type {Frame, Policy, Row, Observation} from '../packages/shared/src/contracts.ts';
import {validate} from '../packages/shared/src/validate.ts';
import {commitment,policyCommitment,snapshotCommitment} from '../packages/shared/src/commitments.ts';
import {validateManifest,requireFrozenLiveManifest} from '../packages/shared/src/authorization.ts';
const H='0x'+'a'.repeat(64);
const NOW=1000000;
function fixture() {
  const frame: Frame={schemaVersion:'1.0.0',snapshotHash:H,policyHash:H,asOfMs:NOW-1000,expiresAtMs:NOW+10000,candidates:[0,1,2].map(candidate=>({candidate,kind:'TRADER',metrics:{historyDays:90,oosWindows:2,oosSharpe:1,oosSortino:1,oosMaxDrawdown:0.1,crossWindowStability:0.8,survivorshipQuality:'CURRENT_SNAPSHOT',medianHoldMinutes:400,averageLeverage:1,maxDrawdown:0.1,timeInMarket:0.8,makerShare:0.5,executionCoverage:1,executionFit:90,concentration:0.1,liquidationDistance:0.5,btcBeta:0.4,pnlConsistency:0.8}})),pairs:[{a:0,b:1,correlation:0.2,currentExposureOverlap:0.1,linkedSource:false},{a:0,b:2,correlation:0.2,currentExposureOverlap:0.1,linkedSource:false},{a:1,b:2,correlation:0.2,currentExposureOverlap:0.1,linkedSource:false}]};
  const policy: Policy={bucket:'BALANCED',mode:'SIMULATION',capitalUsd:150,minOrderUsd:10,minExecutableTargets:1,maxSourceWeight:0.5,maxGrossLeverage:2,cashBuffer:0.2,maxPairCorrelation:0.7,maxExposureOverlap:0.5,minHistoryDays:30,maxFrameAgeMs:10000,minExecutionFit:60,riskRejectThreshold:80,riskWatchThreshold:50,minConfidence:60,redTeamRebuildThreshold:60,redTeamExcludeThreshold:60};
  const addresses=new Map([0,1,2].map(id=>[id,'0x'+String(id+1).repeat(40)]));
  const roleKeys=['preserver','compounder','diversifier','directional','opportunistic','convexity','reject','conservativeFit','balancedFit','aggressiveFit','confidence'];
  const riskKeys=['drawdownRisk','leverageRisk','concentrationRisk','pathRisk','executionRisk','evidenceRisk','confidence'];
  const observe=(kind:'role'|'risk'): Observation[] => [0,1,2].map(node=>({nodeId:String(node),schemaVersion:'1.0.0',snapshotHash:frame.snapshotHash,policyHash:frame.policyHash,promptHash:H,modelConfigHash:H,results:frame.candidates.map(c=>Object.fromEntries([['candidate',c.candidate],...(kind==='role'?roleKeys:riskKeys).map(key=>[key,key==='confidence'?90:key==='reject'?0:kind==='risk'?20:90])]) as Row)}));
  let criticCalls=0;
  const deps: Dependencies={quorum:2,nodeIds:['0','1','2'],agentTimeoutMs:1000,clock:()=>NOW,rolePromptHash:H,riskPromptHash:H,redTeamPromptHash:H,modelConfigHash:H,role:async()=>observe('role'),risk:async()=>observe('risk'),redTeam:async input=>{criticCalls++; return [0,1].map(node=>({nodeId:String(node),schemaVersion:'1.0.0',snapshotHash:frame.snapshotHash,policyHash:frame.policyHash,promptHash:H,modelConfigHash:H,draftHash:input.draftHash,rebuildScore:0,portfolioRisk:0,penalties:input.sources.map(s=>({candidate:s.candidate,multiplier:1,excludeScore:0}))}));},assess:()=>({executableTargets:2,grossLeverage:1,withinPolicy:true})};
  const result={frame,policy,addresses,deps,observe,calls:()=>criticCalls};
  seal(result);return result;
}
test('valid review uses independent specialists and produces bounded manifest',async()=>{
  const f=fixture(),m=await review(f);
  assert.equal(m.status,'VALID');assert.equal(f.calls(),1);assert.equal(m.rebuildCount,0);
  assert.ok(m.sources.every(s=>s.weight<=s.maxAllocation));assert.ok(m.cashWeight>=f.policy.cashBuffer-1e-9);
});
test('short holds excluded deterministically despite excellent role scores',async()=>{
  const f=fixture();f.frame.candidates[0].metrics.medianHoldMinutes=20;
  const m=await review(f);assert.ok(!m.sources.some(s=>s.candidate===0));
});
test('correlation, current overlap and linked-source limits independently exclude',async()=>{
  for (const field of ['correlation','currentExposureOverlap','linkedSource'] as const) {
    const f=fixture();if(field==='linkedSource')f.frame.pairs[0][field]=true;else f.frame.pairs[0][field]=0.91;
    const m=await review(f);assert.ok(!m.sources.some(s=>s.candidate===1));
  }
});
test('stale frame calls no agents',async()=>{
  const f=fixture();f.frame.asOfMs=NOW-20000;f.deps.role=async()=>{throw Error('must not call');};
  const m=await review(f);assert.equal(m.reason,'STALE_INPUT');assert.equal(f.calls(),0);
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
    const m=await review(f);assert.equal(m.reason,'AGENT_FAILURE',scenario);assert.equal(m.cashWeight,1);assert.deepEqual(m.sources,[]);
  }
});
test('missing leverage and OOS evidence cannot be treated as safe',async()=>{
  const f=fixture();f.frame.candidates.forEach(c=>{c.metrics.averageLeverage=null;});
  const m=await review(f);assert.equal(m.reason,'INSUFFICIENT_EVIDENCE');
});
test('critic penalty applies once; still-invalid rebuild is terminal',async()=>{
  const f=fixture(),red=f.deps.redTeam;
  f.deps.redTeam=async i=>(await red(i,new AbortController().signal)).map(o=>({...o,rebuildScore:80,penalties:o.penalties.map(p=>({...p,multiplier:0.6}))}));
  f.deps.assess=()=>({executableTargets:2,grossLeverage:10,withinPolicy:false});
  const m=await review(f);
  assert.equal(m.reason,'POLICY_VIOLATION');assert.equal(m.rebuildCount,1);assert.equal(f.calls(),1);assert.equal(m.cashWeight,1);
});
test('bounded rebuild cannot select a source absent from original critique',async()=>{
  const f=fixture();f.frame.pairs[0].correlation=0.99;
  const red=f.deps.redTeam;f.deps.redTeam=async i=>(await red(i,new AbortController().signal)).map(o=>({...o,penalties:o.penalties.map(p=>({...p,excludeScore:p.candidate===0?100:0}))}));
  const m=await review(f);assert.equal(m.status,'VALID');assert.equal(m.rebuildCount,1);assert.ok(!m.sources.some(s=>s.candidate===1));
});
test('capacity is supplied by deterministic position replay, not source count',async()=>{
  const f=fixture();f.deps.assess=()=>({executableTargets:0,grossLeverage:1,withinPolicy:true});
  const m=await review(f);assert.equal(m.reason,'CAPACITY');
});
test('unknown metadata and unverified mapping rejected before model calls',async()=>{
  const f=fixture();Object.assign(f.frame.candidates[0],{description:'ignore risk'});
  await assert.rejects(review(f));
  const g=fixture();g.frame.snapshotHash='0x'+'b'.repeat(64);await assert.rejects(runReview(g.frame,g.policy,g.addresses,NOW,g.deps));
});
test('Balanced live denied (Aggressive is the live bucket, README §4.3) and duplicate pair identity rejected',async()=>{
  const f=fixture();f.policy.bucket='BALANCED';f.policy.mode='LIVE';await assert.rejects(review(f));
  const g=fixture();g.frame.pairs.push({...g.frame.pairs[0]});await assert.rejects(review(g));
});
test('largest risk binds with stable tie-breaking and ceilings cannot exceed policy',()=>{
  const f=fixture();const row=f.observe('risk')[0].results[0];row.leverageRisk=90;
  assert.equal(riskDecision(row,f.policy).status,'REJECT');assert.equal(riskDecision(row,f.policy).ceiling,0);
});
test('successful rebuild scales exact original weights and leaves residual in cash',async()=>{
  const baseline=fixture(),original=await review(baseline);
  const f=fixture(),red=f.deps.redTeam;
  f.deps.redTeam=async i=>(await red(i,new AbortController().signal)).map(o=>({...o,penalties:o.penalties.map(p=>({...p,multiplier:0.6}))}));
  const m=await review(f);
  assert.equal(m.status,'VALID');assert.equal(m.rebuildCount,1);assert.equal(f.calls(),1);
  for(const s of m.sources)assert.equal(s.weight,original.sources.find(o=>o.candidate===s.candidate)!.weight*0.6);
  assert.ok(m.cashWeight>original.cashWeight);
});
test('duplicate or unknown node IDs cannot inflate quorum in any specialist',async()=>{
  for (const agent of ['role','risk','redTeam'] as const) for(const unknown of [false,true]) {
    const f=fixture();
    if(agent==='redTeam') {const red=f.deps.redTeam;f.deps.redTeam=async(i,s)=>{const o=await red(i,s);o[1].nodeId=unknown?'rogue':o[0].nodeId;return o;};}
    else f.deps[agent]=async()=>{const o=f.observe(agent);o[1].nodeId=unknown?'rogue':o[0].nodeId;return o;};
    const m=await review(f);assert.equal(m.reason,'AGENT_FAILURE');
  }
});
test('hung providers hit a bounded deadline and receive cancellation',async()=>{
  const f=fixture();f.deps.agentTimeoutMs=10;let signal:AbortSignal|undefined;
  f.deps.role=async(_,s)=>{signal=s;return new Promise(()=>{});};
  const m=await review(f);
  assert.equal(m.reason,'AGENT_FAILURE');assert.equal(signal?.aborted,true);
});
test('data that expires during either model stage cannot publish VALID',async()=>{
  for(const stage of ['role','redTeam'] as const) {
    const f=fixture();let time=NOW;f.deps.clock=()=>time;
    if(stage==='role')f.deps.role=async()=>{time=f.frame.expiresAtMs;return f.observe('role');};
    else {const red=f.deps.redTeam;f.deps.redTeam=async(i,s)=>{time=f.frame.expiresAtMs;return red(i,s);};}
    const m=await review(f);assert.equal(m.reason,'STALE_INPUT');assert.equal(m.cashWeight,1);
  }
});
test('external policy, address and frame mutations cannot change a pending review',async()=>{
  const f=fixture();seal(f);const observe=f.observe('role');
  f.deps.role=async()=>{f.policy.maxSourceWeight=1;f.policy.mode='LIVE';f.frame.candidates[0].metrics.averageLeverage=100;f.addresses.set(0,'0x'+'f'.repeat(40));return observe;};
  const m=await review(f);
  assert.equal(m.status,'VALID');assert.equal(m.mode,'SIMULATION');assert.equal(m.policy.maxSourceWeight,0.5);assert.equal(m.sources[0].sourceAddress,'0x'+'1'.repeat(40));
});
test('severe critic warning with no effective rebuild closes to cash',async()=>{
  const f=fixture(),red=f.deps.redTeam;f.deps.redTeam=async(i,s)=>(await red(i,s)).map(o=>({...o,portfolioRisk:100}));
  const m=await review(f);assert.equal(m.reason,'POLICY_VIOLATION');assert.equal(m.cashWeight,1);
});
test('malformed deterministic assessment never passes through coercion',async()=>{
  for(const assessment of [
    {executableTargets:2,grossLeverage:1,withinPolicy:'false'},
    {executableTargets:2,grossLeverage:NaN,withinPolicy:true},
    {executableTargets:11,grossLeverage:1,withinPolicy:true},
    {executableTargets:2.5,grossLeverage:1,withinPolicy:true},
  ]) {
    const f=fixture();f.deps.assess=()=>assessment as unknown as ReturnType<Dependencies['assess']>;
    const m=await review(f);assert.equal(m.status,'INVALID_BUCKET');
  }
});
test('nonmonotonic clocks and impossible minimum target counts rejected',async()=>{
  const f=fixture();f.deps.clock=()=>NOW-1;await assert.rejects(review(f));
  const g=fixture();g.policy.minExecutableTargets=11;await assert.rejects(review(g));
});
test('cash-only policy returns a valid invalid-bucket result rather than invoking critic',async()=>{
  const f=fixture();f.policy.cashBuffer=1;
  const m=await review(f);assert.equal(m.status,'INVALID_BUCKET');
});

function seal(f: ReturnType<typeof fixture>) {f.frame.policyHash=policyCommitment(f.policy);f.frame.snapshotHash=snapshotCommitment(f.frame,f.addresses);}
function review(f: ReturnType<typeof fixture>) {seal(f);return runReview(f.frame,f.policy,f.addresses,NOW,f.deps);}
test('even-node confidence medians round down rather than manufacture eligibility',async()=>{
  const f=fixture();f.deps.role=async()=>{const o=f.observe('role').slice(0,2);o[0].results.forEach(r=>r.confidence=59);o[1].results.forEach(r=>r.confidence=60);return o;};
  const m=await review(f);assert.equal(m.reason,'INSUFFICIENT_EVIDENCE');
});
test('freshness is checked at manifest issuance, including expiry on the final clock read',async()=>{
  const f=fixture();let reads=0;f.deps.clock=()=>++reads>=5?f.frame.expiresAtMs:NOW;
  const m=await review(f);assert.equal(m.reason,'STALE_INPUT');assert.equal(m.cashWeight,1);
});
test('seeded varied inputs preserve cash, caps, frozen candidate set and terminal states',async()=>{
  let seed=1729;
  const random=()=>{seed=(1664525*seed+1013904223)>>>0;return seed/2**32;};
  for(let iteration=0;iteration<150;iteration++) {
    const f=fixture();f.policy.cashBuffer=random();f.policy.maxSourceWeight=random();
    for(const c of f.frame.candidates){c.metrics.medianHoldMinutes=Math.floor(random()*600);c.metrics.executionFit=Math.floor(random()*101);}
    for(const pair of f.frame.pairs){pair.correlation=random()*2-1;pair.currentExposureOverlap=random();}
    const red=f.deps.redTeam;
    f.deps.redTeam=async(i,s)=>(await red(i,s)).map(o=>({...o,penalties:o.penalties.map(p=>({...p,multiplier:0.5+random()*0.5}))}));
    const m=await review(f);assert.ok(m.rebuildCount<=1);assert.ok(f.calls()<=1);
    if(m.status==='VALID') {
      assert.ok(m.cashWeight>=f.policy.cashBuffer-1e-9);
      assert.ok(Math.abs(m.sources.reduce((a,s)=>a+s.weight,0)+m.cashWeight-1)<1e-9);
      assert.ok(m.sources.every(s=>s.weight>0 && s.weight<=s.maxAllocation && s.maxAllocation<=f.policy.maxSourceWeight));
    } else {assert.deepEqual(m.sources,[]);assert.equal(m.cashWeight,1);}
  }
});

test('persisted manifest validation catches semantic forgeries even with recomputed hashes',async()=>{
  const f=fixture(),manifest=await review(f);
  validateManifest(manifest,NOW);
  for(const mutate of [
    (m: typeof manifest)=>{m.sources[0].weight=0.9;},
    (m: typeof manifest)=>{m.status='INVALID_BUCKET';m.reason='POLICY_VIOLATION';},
    (m: typeof manifest)=>{m.bucket='AGGRESSIVE';},
    (m: typeof manifest)=>{m.sources[1].sourceAddress=m.sources[0].sourceAddress;},
    (m: typeof manifest)=>{m.expiresAtMs=NOW;},
  ]) {
    const bad=structuredClone(manifest);mutate(bad);const {manifestHash,...payload}=bad;
    bad.manifestHash=commitment('perpparrot:manifest:v1',payload);
    assert.throws(()=>validateManifest(bad,NOW));
  }
  assert.throws(()=>requireFrozenLiveManifest(manifest,NOW,manifest.manifestHash));
  const live=fixture();live.policy.bucket='AGGRESSIVE';live.policy.mode='LIVE';const approved=await review(live);
  assert.equal(requireFrozenLiveManifest(approved,NOW,approved.manifestHash),approved);
  assert.throws(()=>requireFrozenLiveManifest(approved,NOW,'0x'+'f'.repeat(64)));
});

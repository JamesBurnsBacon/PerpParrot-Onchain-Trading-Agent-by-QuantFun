import {test} from 'node:test';
import {persistCommitteeAudit} from '../packages/backend/src/audit.ts';
import assert from 'node:assert/strict';
import config from '../packages/cre-workflows/review-spike/config.simulation.json' with {type:'json'};
import {validateEvidence} from '../packages/shared/src/review-wire.ts';
import {bindCommitteeEvidence} from '../packages/shared/src/committee-evidence.ts';
import {policyCommitment,snapshotCommitment,commitment} from '../packages/shared/src/commitments.ts';
import type {Frame} from '../packages/shared/src/contracts.ts';
import {fixture} from './support/mirror-fixture.ts';
function setup(){const evidence=validateEvidence(structuredClone(config.evidence)),policy=fixture().configuration.policy,addresses=new Map(evidence.finalists.map(f=>[f.candidate,'0x'+String(f.candidate+1).repeat(40)]));
 const frame:Frame={schemaVersion:'1.0.0',snapshotHash:'0x'+'0'.repeat(64),policyHash:policyCommitment(policy),asOfMs:evidence.asOfMs,expiresAtMs:evidence.asOfMs+10000,candidates:evidence.finalists.map(f=>({candidate:f.candidate,kind:f.kind,metrics:{historyDays:f.historyDays,timeInMarket:f.timeInMarket!,medianHoldMinutes:f.medianHoldMinutes,makerShare:f.makerShare,maxDrawdown:f.maxDrawdown!,oosWindows:2,oosSharpe:1,oosSortino:1,oosMaxDrawdown:0.1,crossWindowStability:0.8,survivorshipQuality:'CURRENT_SNAPSHOT',averageLeverage:1,executionCoverage:1,executionFit:90,concentration:0.1,liquidationDistance:0.5,btcBeta:0.4,pnlConsistency:0.8}})),pairs:evidence.pairs.map(p=>({...p,currentExposureOverlap:0.1}))};
 frame.snapshotHash=snapshotCommitment(frame,addresses);return {evidence,frame,policy,addresses};}
test('committee bridge binds full anonymous evidence without inventing specialist scores',()=>{
 const f=setup(),bound=bindCommitteeEvidence(f.frame,f.policy,f.addresses,f.evidence);
 assert.equal(bound.finalists[0].equityCurve.length,26);assert.equal(bound.finalists[0].metrics.oosWindows,2);
 assert.ok([...f.addresses.values()].every(address=>!JSON.stringify(bound).includes(address)));
 assert.notEqual(bindCommitteeEvidence(f.frame,f.policy,f.addresses,{...f.evidence,finalists:f.evidence.finalists.map((x,i)=>i?x:{...x,patterns:{...x.patterns,observedFills:99}})}).evidenceHash,bound.evidenceHash);
});
test('contradictory feature summaries and matrix bindings reject before model calls',()=>{
 const f=setup();f.evidence.finalists[0].historyDays++;assert.throws(()=>bindCommitteeEvidence(f.frame,f.policy,f.addresses,f.evidence),/contradictory/);
 const pair=setup();pair.evidence.pairs[0].linkedSource=!pair.evidence.pairs[0].linkedSource;assert.throws(()=>bindCommitteeEvidence(pair.frame,pair.policy,pair.addresses,pair.evidence),/matrix/);
});
test('audit adapter persists only schema-validated, input-bound committee output',async()=>{
 const f=setup(),evidence=bindCommitteeEvidence(f.frame,f.policy,f.addresses,f.evidence),system='fixed analyst instructions';
 const fields=['preserver','compounder','diversifier','directional','opportunistic','convexity','reject','conservativeFit','balancedFit','aggressiveFit','confidence'];
 const output={schemaVersion:'1.0.0',snapshotHash:f.frame.snapshotHash,policyHash:f.frame.policyHash,promptHash:commitment('perpparrot:prompt:v1',system),modelConfigHash:'0x'+'a'.repeat(64),quorum:1,results:f.frame.candidates.map(candidate=>({candidate:candidate.candidate,...Object.fromEntries(fields.map(field=>[field,70]))}))};
 let calls=0;
 const rpc={async call(name:string,args:Record<string,unknown>){calls++;assert.equal(name,'persist_review_audit');assert.ok(args.p_record);return null;}};
 const id=await persistCommitteeAudit(rpc,'role','pinned-model',system,evidence,output,f.frame.asOfMs);
 assert.equal(id.length,66);assert.equal(calls,1);
 await assert.rejects(()=>persistCommitteeAudit(rpc,'role','pinned-model',system,evidence,{...output,apiKey:'must-not-persist'},f.frame.asOfMs));
 await assert.rejects(()=>persistCommitteeAudit(rpc,'role','pinned-model',system,evidence,{...output,snapshotHash:'0x'+'b'.repeat(64)},f.frame.asOfMs));
 assert.equal(calls,1);
});

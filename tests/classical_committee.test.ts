import {test} from 'node:test';
import assert from 'node:assert/strict';
import {classicalCommittee,classicalRisk,classicalRole} from '../packages/backend/review/models/classical.ts';
import {runCommitteeReview} from '../packages/backend/review/committee/workflow.ts';
import {paperFixture,NOW} from './support/paper-lifecycle-fixture.ts';

function setup(){
 const f=paperFixture({async call(){return null;}});
 const audited:{stage:string;rows:unknown[]}[]=[];
 const deps=classicalCommittee({...f.deps,audit:async(stage,_,rows)=>{audited.push({stage,rows});return rows.map((__,i)=>'0x'+String(i+1+(['role','risk','redteam'].indexOf(stage)*2)).repeat(64));}},f.input.policy.minHistoryDays);
 return {f,deps,audited};
}
type Metrics=Parameters<typeof classicalRisk>[0];
const metrics=(over:Partial<Metrics>={}):Metrics=>({historyDays:120,oosWindows:2,oosSharpe:0.6,oosSortino:3,oosMaxDrawdown:0.05,crossWindowStability:0.6,survivorshipQuality:'CURRENT_SNAPSHOT',
 medianHoldMinutes:600,averageLeverage:1.5,maxDrawdown:0.12,timeInMarket:0.7,makerShare:0.2,executionCoverage:0.9,executionFit:80,concentration:0.4,liquidationDistance:0.4,btcBeta:null,
 pnlConsistency:0.8,isSharpe:1,isSortino:2,isCalmar:1,lookbackDays:30,scoreFlags:[],cloneCount:0,...over});

test('classical committee answers every stage through the review core without a model',async()=>{
 const s=setup();assert.deepEqual(s.deps.nodeIds,['classical']);assert.equal(s.deps.quorum,1);
 const receipt=await runCommitteeReview(s.f.input.frame,s.f.input.policy,s.f.input.addresses,s.f.input.rich,NOW,s.deps);
 assert.notEqual(receipt.manifest.reason,'AGENT_FAILURE');
 assert.deepEqual(s.audited.map(a=>a.stage).slice(0,2).sort(),['risk','role']);
 // Deterministic: the same evidence gives the same receipt.
 const again=await runCommitteeReview(s.f.input.frame,s.f.input.policy,s.f.input.addresses,s.f.input.rich,NOW,setup().deps);
 assert.equal(again.receiptHash,receipt.receiptHash);
});

test('scores stay integers in 0–100 and unknowns never read as safe',()=>{
 const empty=metrics({oosWindows:0,oosSharpe:null,oosSortino:null,oosMaxDrawdown:null,crossWindowStability:null,medianHoldMinutes:null,averageLeverage:null,executionFit:null,liquidationDistance:null,concentration:null,isSharpe:null,isSortino:null});
 for(const m of [metrics(),empty,metrics({maxDrawdown:5,averageLeverage:80,oosSharpe:-9,oosSortino:-10})]){
  for(const v of [...Object.values(classicalRisk(m)),...Object.values(classicalRole(m,0.3,30))]){assert.ok(Number.isInteger(v)&&v>=0&&v<=100,String(v));}
 }
 const known=classicalRisk(metrics()),unknown=classicalRisk(empty);
 assert.ok(unknown.evidenceRisk>known.evidenceRisk);assert.ok(unknown.confidence<known.confidence);
 assert.ok(unknown.executionRisk>=50);
});

test('risk is assessed per dimension: severe drawdown or leverage rejects, returns never offset it',()=>{
 assert.ok(classicalRisk(metrics({maxDrawdown:0.55})).drawdownRisk>80);
 assert.ok(classicalRisk(metrics({averageLeverage:9})).leverageRisk>80);
 assert.ok(classicalRisk(metrics({liquidationDistance:0.02})).leverageRisk>80);
 assert.ok(classicalRisk(metrics({averageLeverage:9,oosSharpe:5,oosSortino:10})).leverageRisk>80);
 // A one-perp book or an unstable record is a concern, never a reject on its own.
 assert.ok(classicalRisk(metrics({concentration:1})).concentrationRisk<=80);
 assert.ok(classicalRisk(metrics({crossWindowStability:0,pnlConsistency:0})).pathRisk<=80);
 const calm=classicalRisk(metrics());
 for(const k of ['drawdownRisk','leverageRisk','concentrationRisk','pathRisk','executionRisk'] as const)assert.ok(calm[k]<=80,k);
});

test('fit rewards stable risk-adjusted returns and discounts drawdown and short holds; losing out of sample rejects',()=>{
 const good=classicalRole(metrics(),0.3,30);
 assert.ok(good.aggressiveFit>classicalRole(metrics({crossWindowStability:0}),0.3,30).aggressiveFit);
 assert.ok(good.aggressiveFit>classicalRole(metrics({maxDrawdown:0.4}),0.3,30).aggressiveFit);
 assert.ok(good.aggressiveFit>classicalRole(metrics({medianHoldMinutes:45}),0.3,30).aggressiveFit);
 assert.ok(good.aggressiveFit>=good.balancedFit&&good.balancedFit>=good.conservativeFit);
 assert.ok(good.reject<80);assert.ok(good.aggressiveFit>0);
 assert.ok(classicalRole(metrics({oosSharpe:-0.3,oosSortino:-0.5}),0.3,30).reject>=80);
 assert.ok(classicalRole(metrics({historyDays:10}),0.3,30).reject>=80);
 assert.equal(good.convexity,0);
});

import {test} from 'node:test';
import assert from 'node:assert/strict';
import {buildReviewInput,positionsFromStates} from '../packages/backend/review/input.ts';
import {runReview,type Dependencies} from '../packages/backend/review/workflow.ts';
import {verifyInputCommitments} from '../packages/shared/src/commitments.ts';
import {CONTRACT_VERSION,type Observation,type Row} from '../packages/shared/src/contracts.ts';
import {setup,address,NOW} from './support/score-frame.ts';
test('Score finalists become a 1.1.0 frame that passes the schema and input commitments',()=>{
  const args=setup(),built=buildReviewInput(args);
  assert.equal(built.frame.schemaVersion,CONTRACT_VERSION);
  assert.ok(verifyInputCommitments(built.frame,args.policy,built.addresses));
  // The 10-point curve is too short for the model's 26-point minimum: skipped, its pairs dropped.
  assert.deepEqual(built.skipped,[{address:address(3),reason:'short-curve'}]);
  assert.deepEqual([...built.addresses],[[0,address(1)],[1,address(2)]]);
  assert.deepEqual(built.frame.pairs,[{a:0,b:1,correlation:0.42,currentExposureOverlap:null,linkedSource:false}]);
  const [first]=built.frame.candidates;
  assert.deepEqual(first!.clones,[address(99)]);
  assert.equal(first!.metrics.cloneCount,1);
  for(const field of ['executionCoverage','executionFit','concentration','liquidationDistance','btcBeta'] as const)assert.equal(first!.metrics[field],null);
  assert.equal(first!.metrics.survivorshipQuality,'CURRENT_SNAPSHOT');
});
test('model evidence is anonymous: counts, not clone addresses, and no source addresses',()=>{
  const args=setup(),built=buildReviewInput(args),payload=JSON.stringify(built.committee);
  for(const n of [1,2,3,99])assert.ok(!payload.toLowerCase().includes(address(n)),address(n));
  assert.equal(built.committee.finalists[0]!.metrics.cloneCount,1);
  assert.equal(built.committee.finalists[0]!.metrics.isSharpe,1.5);
  assert.ok(built.evidence.finalists.every(f=>f.equityCurve.length>=26&&f.equityCurve.length<=48));
  assert.deepEqual(built.evidence.finalists[0]!.patterns,{increasesAfterLoss:null,repeatedRoundTrips:null,observedFills:null});
});
test('a missing position read fails instead of claiming a flat book',()=>{
  const args=setup();args.positions.delete(address(2));
  assert.throws(()=>buildReviewInput(args),/positions not read/);
});
test('a book over the 4 KB finalist budget is trimmed: the curve is thinned before any position is dropped',()=>{
  // 48 points and 12 short-named positions fit (~3.8 KB); 64-character market names do not.
  const args=setup([48,48]);
  args.positions.set(address(1),Array.from({length:12},(_,i)=>({market:`xyz:${'L'.repeat(57)}${String(i).padStart(3,'0')}`,signedNotionalUsd:123456.78-i,leverage:12.5,liquidationDistance:0.1234})));
  const built=buildReviewInput(args),[trimmed,untouched]=built.committee.finalists;
  assert.ok(built.committee.finalists.every(f=>new TextEncoder().encode(JSON.stringify(f)).length<=4096));
  // Thinning the curve (evenly, both ends kept) is enough here; every position survives.
  assert.ok(trimmed!.equityCurve.length<48&&trimmed!.equityCurve.length>=26);assert.equal(trimmed!.positions.length,12);
  assert.equal(new TextEncoder().encode(JSON.stringify({...trimmed,equityCurve:[...trimmed!.equityCurve,trimmed!.equityCurve[0]]})).length>4096,true);
  assert.equal(untouched!.equityCurve.length,48);
});
test('clearinghouse positions: signed notional, liquidation distance, largest first',()=>{
  const rows=positionsFromStates([{assetPositions:[
    {position:{coin:'ETH',szi:'-2',positionValue:'8000',leverage:{value:5},liquidationPx:'4800'}},
    {position:{coin:'BTC',szi:'0.5',positionValue:'50000',leverage:{value:10},liquidationPx:null}},
  ]},{assetPositions:[{position:{coin:'xyz:MSFT',szi:'3',positionValue:'1500',liquidationPx:'400'}}]}]);
  assert.deepEqual(rows,[
    {market:'BTC',signedNotionalUsd:50000,leverage:10,liquidationDistance:null},
    {market:'ETH',signedNotionalUsd:-8000,leverage:5,liquidationDistance:0.2},
    {market:'xyz:MSFT',signedNotionalUsd:1500,leverage:null,liquidationDistance:0.2},
  ]);
  assert.throws(()=>positionsFromStates([{assetPositions:[{position:{coin:'X',szi:'0',positionValue:'0'}}]}]),/invalid position/);
});
test('end to end: a frame built from Score reaches the review, which rejects it for missing OOS evidence',async()=>{
  const args=setup(),{frame,addresses}=buildReviewInput(args),H='0x'+'a'.repeat(64);
  const rows=(keys:string[])=>frame.candidates.map(c=>Object.fromEntries([['candidate',c.candidate],...keys.map(k=>[k,k==='reject'?0:90])]) as Row);
  const observe=(keys:string[]):Observation[]=>['0','1'].map(nodeId=>({nodeId,schemaVersion:frame.schemaVersion,snapshotHash:frame.snapshotHash,policyHash:frame.policyHash,promptHash:H,modelConfigHash:H,results:rows(keys)}));
  const deps:Dependencies={quorum:2,nodeIds:['0','1'],agentTimeoutMs:1000,clock:()=>NOW+1000,rolePromptHash:H,riskPromptHash:H,redTeamPromptHash:H,modelConfigHash:H,
    role:async()=>observe(['preserver','compounder','diversifier','directional','opportunistic','convexity','reject','conservativeFit','balancedFit','aggressiveFit','confidence']),
    risk:async()=>observe(['drawdownRisk','leverageRisk','concentrationRisk','pathRisk','executionRisk','evidenceRisk','confidence']),
    redTeam:async()=>{throw new Error('not reached');},assess:()=>{throw new Error('not reached');}};
  const manifest=await runReview(frame,args.policy,addresses,NOW+1000,deps);
  assert.equal(manifest.reason,'INSUFFICIENT_EVIDENCE');assert.equal(manifest.sources.length,0);
});

test('additional evidence reaches committee hashes and fits 4 KB without truncating aggregate exposures',()=>{
  const args=setup(),addr=address(1);
  const book=Array.from({length:15},(_,i)=>({market:`COIN${i}`,signedNotionalUsd:100,leverage:2,liquidationDistance:0.3}));
  book.push({market:'xyz:GOLD',signedNotionalUsd:10,leverage:2,liquidationDistance:0.3});
  args.positions.set(addr,book);
  const additional=new Map([[addr,{patterns:{observedFills:20,increasesAfterLoss:0.2,repeatedRoundTrips:0.1,costBasisAdds:5,closedEpisodes:10,continuityBreaks:0},exposureByClass:{crypto:{longUsd:1500,shortUsd:0},gold:{longUsd:10,shortUsd:0},oil:{longUsd:0,shortUsd:0},other:{longUsd:0,shortUsd:0}},
    measurement:{version:'path-beta-v1' as const,fromMs:NOW-30*86400000,toMs:NOW,fillHistory:'API_BOUNDED' as const,btcDailyPairs:28,exposureScope:'core+xyz current positions; all before detail cap' as const}}]]);
  // Fixture's synthetic clock may be <30 days; timestamps remain nonnegative.
  additional.get(addr)!.measurement.fromMs=Math.max(0,NOW-30*86400000);
  const measured=new Map([[addr,{btcBeta:1.25}]]);
  const built=buildReviewInput({...args,additional,measured});
  const row=built.committee.finalists[0]!;
  assert.equal(row.metrics.btcBeta,1.25);assert.equal(row.metrics.survivorshipQuality,'CURRENT_SNAPSHOT');
  assert.equal(row.exposureByClass?.gold.longUsd,10);assert.equal(row.patterns.costBasisAdds,5);
  assert.ok(row.positions.length<=12);assert.ok(Buffer.byteLength(JSON.stringify(row))<=4096);
  const original=built.committee.evidenceHash;
  additional.get(addr)!.patterns.increasesAfterLoss=0.8;
  assert.notEqual(buildReviewInput({...args,additional,measured}).committee.evidenceHash,original);
});

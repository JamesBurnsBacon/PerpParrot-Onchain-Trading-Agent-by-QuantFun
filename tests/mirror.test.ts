import {test} from 'node:test';
import assert from 'node:assert/strict';
import {commitment, policyCommitment} from '../packages/shared/src/commitments.ts';
import {proposeFreeze, requireConfirmedFreeze, validateFrozenConfiguration} from '../packages/shared/src/frozen.ts';
import {buildMirrorPlan, snapshotHash} from '../packages/cre-workflows/mirror/core.ts';
import type {MirrorInput, AccountState} from '../packages/cre-workflows/mirror/core.ts';
import type {Policy, Manifest} from '../packages/shared/src/contracts.ts';
import {selectSpotChecks} from '../packages/cre-workflows/mirror/operations.ts';

import {fixture} from './support/mirror-fixture.ts';
const hash = '0x' + 'b'.repeat(64);
function reseal(input: MirrorInput) {
  const {snapshotHash:_, ...payload} = input.snapshot;
  input.snapshot.snapshotHash = snapshotHash(payload);
}
function ready(input: MirrorInput) {
  const result = buildMirrorPlan(input);
  assert.equal(result.status, 'READY', result.status === 'HOLD' ? result.reason : '');
  if (result.status !== 'READY') throw new Error('expected plan');
  return result.plan;
}
test('frozen configuration survives original review expiry while fresh state remains mandatory', () => {
  const input = fixture();
  const plan = ready(input);
  assert.equal(plan.mode,'PAPER');
  assert.deepEqual(plan.targets,[{market:'BTC',notionalMicros:'600000000'}]);
  assert.equal(plan.expiresAtMs,3900);
  input.nowMs = 4000;
  assert.equal(buildMirrorPlan(input).status,'HOLD');
});
test('unconfirmed freeze, wrong account/chain/hash and tampered frozen weight reject', () => {
  for (const key of ['active','account','chainId','configurationHash'] as const) {
    const input = fixture();
    Object.assign(input.confirmedFreeze,{[key]:key === 'active' ? false : key === 'chainId' ? 1 : hash});
    assert.equal(buildMirrorPlan(input).status,'HOLD');
  }
  const input=fixture();input.configuration.sources[0].weightUnits++;
  assert.throws(() => validateFrozenConfiguration(input.configuration));
});
test('frozen configuration enforces 5–25 sources, sorted identities and exact fields', () => {
  const input=fixture();input.configuration.sources.pop();
  assert.throws(() => validateFrozenConfiguration(input.configuration));
  const sorted=fixture();sorted.configuration.sources.reverse();
  assert.throws(() => validateFrozenConfiguration(sorted.configuration));
  const extra=fixture();Object.assign(extra.configuration,{expiresAtMs:999999});
  assert.throws(() => validateFrozenConfiguration(extra.configuration));
  assert.throws(() => requireConfirmedFreeze(fixture().configuration,fixture().confirmedFreeze,999));
});
test('snapshot tampering, missing sources and duplicate spot checks hold', () => {
  const modified=fixture();modified.snapshot.sources[0].positions[0].notionalMicros='1';
  assert.equal(buildMirrorPlan(modified).status,'HOLD');
  const missing=fixture();missing.snapshot.sources.pop();reseal(missing);
  assert.equal(buildMirrorPlan(missing).status,'HOLD');
  const checks=fixture();checks.checks[0]=checks.checks[1];
  assert.equal(buildMirrorPlan(checks).status,'HOLD');
});
test('offsetting market discrepancies cannot cancel out in spot checks', () => {
  const input=fixture();
  input.snapshot.sources[0].positions=[{market:'BTC',notionalMicros:'100000000'},{market:'ETH',notionalMicros:'-100000000'}];
  input.checks[0].positions=[];reseal(input);
  const result=buildMirrorPlan(input);
  assert.equal(result.status,'HOLD');
  if (result.status === 'HOLD') assert.match(result.reason,/5%/);
});
test('5% boundary passes and any excess or material equity discrepancy holds', () => {
  const input=fixture();input.checks[0].positions[0].notionalMicros='1050000000';
  ready(input);
  input.checks[0].positions[0].notionalMicros='1050000001';
  assert.equal(buildMirrorPlan(input).status,'HOLD');
  const equity=fixture();equity.checks[0].equityMicros='500000000';
  assert.equal(buildMirrorPlan(equity).status,'HOLD');
});
test('all-flat sources produce reduce-only close rather than division by zero', () => {
  const input=fixture();input.snapshot.sources.forEach(state => state.positions=[]);input.checks.forEach(state => state.positions=[]);reseal(input);
  input.account.positions=[{market:'BTC',notionalMicros:'100000000'}];
  assert.deepEqual(ready(input).deltas,[{market:'BTC',notionalMicros:'-100000000',reduceOnly:true}]);
});
test('active-source renormalization cannot exceed a frozen ceiling', () => {
  const input=fixture();input.snapshot.sources.slice(1).forEach(state => state.positions=[]);input.checks.slice(1).forEach(state => state.positions=[]);reseal(input);
  const result=buildMirrorPlan(input);assert.equal(result.status,'HOLD');
  if(result.status==='HOLD')assert.match(result.reason,/concentration/);
});
test('net opposing positions before applying minimum order and drift gates', () => {
  const input=fixture();input.snapshot.sources[0].positions[0].notionalMicros='-1000000000';input.checks[0].positions[0].notionalMicros='-1000000000';reseal(input);
  assert.equal(ready(input).targets[0].notionalMicros,'360000000');
  input.account.positions=[{market:'BTC',notionalMicros:'351000000'}];
  assert.deepEqual(ready(input).deltas,[]);
  input.account.positions=[{market:'BTC',notionalMicros:'340000000'}];
  assert.deepEqual(ready(input).deltas,[]); // $20 exceeds floor but is below 10% of target.
});
test('reduce-only markets cannot open, increase or reverse exposure', () => {
  const input=fixture();input.markets[0].reduceOnly=true;
  assert.equal(ready(input).targets[0].notionalMicros,'0');
  input.account.positions=[{market:'BTC',notionalMicros:'-100000000'}];
  assert.deepEqual(ready(input).deltas,[{market:'BTC',notionalMicros:'100000000',reduceOnly:true}]);
  input.account.positions[0].notionalMicros='100000000';
  assert.equal(ready(input).targets[0].notionalMicros,'100000000');
});
test('unsafe money encodings and incomplete held-market policy hold', () => {
  for (const value of ['NaN','1e9','01','-0','1000000000000000000000000']) {
    const input=fixture();input.account.equityMicros=value;
    assert.equal(buildMirrorPlan(input).status,'HOLD');
  }
  const input=fixture();input.account.positions=[{market:'ETH',notionalMicros:'100000000'}];
  assert.equal(buildMirrorPlan(input).status,'HOLD');
});
test('market and gross exposure limits reject a feasible-looking target', () => {
  const market=fixture();market.markets[0].maxAbsNotionalMicros='500000000';
  assert.equal(buildMirrorPlan(market).status,'HOLD');
  const gross=fixture();gross.snapshot.sources.forEach(state => state.positions[0].notionalMicros='4000000000');gross.checks=structuredClone(gross.snapshot.sources);gross.markets[0].maxAbsNotionalMicros='5000000000';reseal(gross);
  assert.equal(buildMirrorPlan(gross).status,'HOLD');
});
test('deterministic plans leave inputs unchanged and bind fresh account state', () => {
  const input=fixture(),before=structuredClone(input);
  const plan=ready(input);
  assert.deepEqual(input,before);assert.deepEqual(ready(input),plan);
  input.account.positions=[{market:'BTC',notionalMicros:'100000000'}];
  assert.notEqual(ready(input).accountHash,plan.accountHash);
  assert.notEqual(ready(input).planHash,plan.planHash);
});
test('spot-check selection is reproducible and returns ten distinct configured sources', () => {
  const configuration=fixture().configuration;
  configuration.sources=Array.from({length:25},(_,candidate) => ({candidate,sourceAddress:'0x'+(candidate+1).toString(16).padStart(40,'0'),weightUnits:20000,ceilingUnits:100000}));
  configuration.cashUnits=500000;
  const {configurationHash:_,...payload}=configuration;
  configuration.configurationHash=commitment('perpparrot:frozen:v1',payload);
  const seed='0x'+'c'.repeat(64);
  const sample=selectSpotChecks(configuration,seed);
  assert.deepEqual(selectSpotChecks(configuration,seed),sample);
  assert.equal(sample.length,10);assert.equal(new Set(sample).size,10);
  assert.ok(sample.every(address=>configuration.sources.some(source=>source.sourceAddress===address)));
  assert.throws(()=>selectSpotChecks(configuration,'backend-controlled-unvalidated-seed'));
});

test('drift-skipped residual market exposure cannot bypass market limits', () => {
  const input=fixture();
  input.markets.push({market:'ETH',maxAbsNotionalMicros:'5000000',reduceOnly:false});
  input.account.positions=[{market:'ETH',notionalMicros:'9000000'}];
  const result=buildMirrorPlan(input);
  assert.equal(result.status,'HOLD');
  if(result.status==='HOLD') assert.match(result.reason,/projected market/);
});
test('independent partial fills cannot bypass gross leverage limit', () => {
  const input=fixture();
  input.markets.push({market:'ETH',maxAbsNotionalMicros:'2000000000',reduceOnly:false});
  input.account.positions=[{market:'ETH',notionalMicros:'1900000000'}];
  const result=buildMirrorPlan(input);
  assert.equal(result.status,'HOLD');
  if(result.status==='HOLD') assert.match(result.reason,/partial-fill gross/);
});
test('plan commits projected and worst-fill exposure', () => {
  const input=fixture();
  input.account.positions=[{market:'BTC',notionalMicros:'590000000'}];
  const plan=ready(input);
  assert.equal(plan.projectedGrossNotionalMicros,'590000000');
  assert.equal(plan.worstFillGrossNotionalMicros,'590000000');
});

test('equivalent sample and adapter completion ordering produce identical plans',()=>{
  const input=fixture(),plan=ready(input);
  input.sampledAddresses.reverse();input.checks.reverse();input.markets.reverse();
  assert.deepEqual(ready(input),plan);
});

import {commitment, policyCommitment} from '../../packages/shared/src/commitments.ts';
import {proposeFreeze} from '../../packages/shared/src/frozen.ts';
import {snapshotHash} from '../../packages/cre-workflows/mirror/core.ts';
import type {MirrorInput, AccountState} from '../../packages/cre-workflows/mirror/core.ts';
import type {Policy, Manifest} from '../../packages/shared/src/contracts.ts';
const NOW = 3000;
const account = '0x' + 'a'.repeat(40);
const hash = '0x' + 'b'.repeat(64);
export function fixture(): MirrorInput {
  const policy: Policy = {bucket:'BALANCED',mode:'LIVE',capitalUsd:1000,minOrderUsd:10,minExecutableTargets:1,maxSourceWeight:0.3,maxGrossLeverage:2,cashBuffer:0.2,maxPairCorrelation:0.7,maxExposureOverlap:0.5,minHistoryDays:30,maxFrameAgeMs:10000,minExecutionFit:60,riskRejectThreshold:80,riskWatchThreshold:50,minConfidence:60,redTeamRebuildThreshold:60,redTeamExcludeThreshold:60};
  const sources = Array.from({length:5}, (_, candidate) => ({candidate,sourceAddress:'0x' + String(candidate + 1).repeat(40),weight:0.12,maxAllocation:0.3}));
  const payload = {schemaVersion:'1.0.0' as const,snapshotHash:hash,policyHash:policyCommitment(policy),createdAtMs:1000,expiresAtMs:2000,bucket:'BALANCED' as const,mode:'LIVE' as const,status:'VALID' as const,rebuildCount:0 as const,policy,sources,cashWeight:0.4,reason:'OK' as const};
  const manifest: Manifest = {...payload,manifestHash:commitment('perpparrot:manifest:v1',payload)};
  const configuration = proposeFreeze(manifest, account, 999, 1000);
  const states: AccountState[] = sources.map(source => ({address:source.sourceAddress,observedAtMs:2900,equityMicros:'1000000000',positions:[{market:'BTC',notionalMicros:'1000000000'}]}));
  const snapshot = {configurationHash:configuration.configurationHash,publishedAtMs:2950,sources:states};
  return {configuration,confirmedFreeze:{configurationHash:configuration.configurationHash,account,chainId:999,active:true},snapshot:{...snapshot,snapshotHash:snapshotHash(snapshot)},account:{address:account,observedAtMs:2900,equityMicros:'1000000000',positions:[]},checks:structuredClone(states),sampledAddresses:states.map(s => s.address),markets:[{market:'BTC',maxAbsNotionalMicros:'2000000000',reduceOnly:false}],nowMs:NOW,maxStateAgeMs:1000,runId:'mirror:3000'};
}

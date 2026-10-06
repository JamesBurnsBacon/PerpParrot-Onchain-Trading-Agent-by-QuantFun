import config from '../../packages/cre-workflows/review-spike/config.simulation.json' with {type:'json'};
import {fixture} from './review-fixture.ts';
import {validateEvidence} from '../../packages/shared/src/review-wire.ts';
import {policyCommitment,snapshotCommitment,commitment} from '../../packages/shared/src/commitments.ts';
import {committeeAudit} from '../../packages/backend/review/committee-audit.ts';
import type {Frame,Observation,Critique,Row} from '../../packages/shared/src/contracts.ts';
import type {CommitteeDependencies,EvidenceObservation,EvidenceCritique} from '../../packages/cre-workflows/review/committee/types.ts';
import type {Rpc} from '../../packages/backend/review/supabase.ts';
export const NOW=6030000;
export function paperFixture(rpc:Rpc){
  const base=fixture(),policy=base.configuration.policy,addresses=new Map(base.configuration.sources.map(s=>[s.candidate,s.sourceAddress]));
  const original=config.evidence.finalists[0];
  const rich=validateEvidence({asOfMs:NOW-1000,finalists:Array.from({length:5},(_,candidate)=>({...structuredClone(original),candidate,equityCurve:original.equityCurve.map((point,i)=>({...point,atMs:NOW-27000+i*1000}))})),pairs:Array.from({length:5},(_,a)=>Array.from({length:4-a},(_,j)=>({a,b:a+j+1,correlation:0.2,linkedSource:false}))).flat()});
  const frame:Frame={schemaVersion:'1.1.0',snapshotHash:'0x'+'0'.repeat(64),policyHash:policyCommitment(policy),asOfMs:rich.asOfMs,expiresAtMs:NOW+10000,candidates:rich.finalists.map(f=>({candidate:f.candidate,kind:f.kind,clones:[],metrics:{historyDays:f.historyDays,timeInMarket:f.timeInMarket!,medianHoldMinutes:f.medianHoldMinutes,makerShare:f.makerShare,maxDrawdown:f.maxDrawdown!,oosWindows:2,oosSharpe:1,oosSortino:1,oosMaxDrawdown:0.1,crossWindowStability:0.8,survivorshipQuality:'CURRENT_SNAPSHOT',averageLeverage:1,executionCoverage:1,executionFit:90,concentration:0.1,liquidationDistance:0.5,btcBeta:0.4,pnlConsistency:0.8,isSharpe:1,isSortino:1,isCalmar:1,lookbackDays:90,scoreFlags:[],cloneCount:0}})),pairs:rich.pairs.map(p=>({...p,currentExposureOverlap:0.1}))};
  frame.snapshotHash=snapshotCommitment(frame,addresses);
  const prompts={role:'Paper role fixture',risk:'Paper risk fixture',redteam:'Paper critique fixture'},modelConfigHash='0x'+'c'.repeat(64);
  const roleKeys=['preserver','compounder','diversifier','directional','opportunistic','convexity','reject','conservativeFit','balancedFit','aggressiveFit','confidence'],riskKeys=['drawdownRisk','leverageRisk','concentrationRisk','pathRisk','executionRisk','evidenceRisk','confidence'];
  let modelCalls=0;
  const observations=(kind:'role'|'risk',evidenceHash:string):EvidenceObservation[]=>['0','1'].map(nodeId=>({nodeId,schemaVersion:'1.1.0',snapshotHash:frame.snapshotHash,policyHash:frame.policyHash,promptHash:commitment('perpparrot:prompt:v1',prompts[kind]),modelConfigHash,evidenceHash,results:frame.candidates.map(c=>Object.fromEntries([['candidate',c.candidate],...(kind==='role'?roleKeys:riskKeys).map(key=>[key,key==='confidence'?90:key==='reject'?0:kind==='risk'?20:90])]) as Row)}));
  const deps:CommitteeDependencies={quorum:2,nodeIds:['0','1'],agentTimeoutMs:10000,clock:()=>NOW,rolePromptHash:commitment('perpparrot:prompt:v1',prompts.role),riskPromptHash:commitment('perpparrot:prompt:v1',prompts.risk),redTeamPromptHash:commitment('perpparrot:prompt:v1',prompts.redteam),modelConfigHash,
    role:async evidence=>{modelCalls++;return observations('role',evidence.evidenceHash);},risk:async evidence=>{modelCalls++;return observations('risk',evidence.evidenceHash);},
    redTeam:async input=>{modelCalls++;return ['0','1'].map(nodeId=>({nodeId,schemaVersion:'1.1.0',snapshotHash:frame.snapshotHash,policyHash:frame.policyHash,promptHash:commitment('perpparrot:prompt:v1',prompts.redteam),modelConfigHash,evidenceHash:input.evidence.evidenceHash,draftHash:input.draftHash,rebuildScore:0,portfolioRisk:0,penalties:input.sources.map(source=>({candidate:source.candidate,multiplier:1,excludeScore:0}))}));},
    assess:()=>({executableTargets:1,grossLeverage:0.8,withinPolicy:true}),audit:committeeAudit(rpc,'synthetic-model',prompts,()=>NOW)};
  const input={session:'synthetic:aggressive',frame,policy,addresses,rich,nowMs:NOW};
  return {input,deps,modelCalls:()=>modelCalls,account:base.configuration.account,chainId:999};
}

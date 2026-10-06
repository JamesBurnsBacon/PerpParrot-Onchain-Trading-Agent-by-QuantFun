// Real public account observations -> strict Score -> measured Review -> paper-only services.
// No production configuration is changed. All output is under the requested local directory.
import { PGlite } from '@electric-sql/pglite';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { scoreCandidates, toFrameCandidates, parsePortfolio, type ScoreInput } from '../packages/backend/src/score/index.ts';
import { buildReviewInput, type ReviewInput } from '../packages/backend/review/input.ts';
import { measureAccountEvidence, currentExposureOverlap, type ClearinghouseEvidence } from '../packages/backend/review/measured-evidence.ts';
import { portfolioEquityE6 } from '../packages/shared/account.ts';
import { commitment, snapshotCommitment } from '../packages/shared/src/commitments.ts';
import { bindCommitteeEvidence } from '../packages/shared/src/committee-evidence.ts';
import { reviewPaperSession, freezePaperSession } from '../packages/backend/review/paper/lifecycle.ts';
import { SupabasePaperStore } from '../packages/backend/review/paper/store.ts';
import { committeeAudit } from '../packages/backend/review/committee-audit.ts';
import { candidateCompileFailures, riskDecision } from '../packages/backend/review/workflow.ts';
import type { Rpc } from '../packages/backend/review/supabase.ts';
import type { Policy, Row } from '../packages/shared/src/contracts.ts';
import type { CommitteeDependencies } from '../packages/backend/review/committee/types.ts';
import type { FrozenConfiguration as ServiceConfiguration } from '../packages/shared/frozen.ts';
import { buildMeasuredAssessment, runMeasuredService } from './measured-service.ts';
import { verifyMeasuredArchive } from './verify-measured.ts';

const read = <T=any>(p:string):T=>JSON.parse(readFileSync(p,'utf8'));
const save=(p:string,v:unknown)=>writeFileSync(p,JSON.stringify(v,null,2)+'\n');

function stateEvidence(sample:any):ClearinghouseEvidence {
  const states=sample.allStates?.map((s:any)=>s.state)??sample.states;
  return {asOfMs:sample.completedAtMs,complete:sample.stateCoverage?.complete===true,accountValueUsd:Number(portfolioEquityE6(sample.portfolio))/1e6,rawSha256:sample.rawSha256,
    positions:states.flatMap((state:any)=>state.assetPositions.map(({position:p}:any)=>{
      const size=Number(p.szi),value=Number(p.positionValue),mark=size?value/Math.abs(size):0;
      return {coin:p.coin,size,signedNotionalUsd:Math.sign(size)*value,configuredLeverage:p.leverage?.value??null,
        liquidationDistance:p.liquidationPx&&mark>0?Math.min(1,Math.abs(mark-Number(p.liquidationPx))/mark):null};
    })).filter((p:any)=>p.size!==0)};
}

/** Keep full reasons in the bundle summary; schema-bound model flags are compact taxonomy labels. */
export function measuredFlags(original:string[],reasons:string[]):string[]{
  const reasonTags:Record<string,string>={FILL_PAGINATION_INCOMPLETE:'fills-incomplete',INVALID_FILL:'invalid-fill',FILL_OUTSIDE_DECLARED_WINDOW:'fill-outside-window',
    CONFLICTING_DUPLICATE_FILL:'conflicting-fill',POSITION_PATH_AMBIGUOUS:'ambiguous-position-path',TERMINAL_POSITION_MISMATCH:'position-mismatch',
    CURRENT_POSITION_COVERAGE_INCOMPLETE:'positions-incomplete',NO_COMPLETE_OBSERVED_HOLDING_EPISODES:'holding-unmeasured',
    MAKER_SHARE_LESS_THAN_30_DAYS_COVERAGE:'maker-coverage-short',HISTORICAL_AVERAGE_LEVERAGE_UNMEASURED:'leverage-unmeasured',
    LEVERAGE_ONLY_MEASURED_OVER_RECORDED_SAMPLE_INTERVAL:'short-leverage-sample',INSUFFICIENT_FIXED_TEMPORAL_HOLDOUT_COVERAGE:'holdout-coverage-short',
    EXECUTION_REPLAY_ASSESSMENT_REQUIRED:'no-latency-replay'};
  const tags=[...new Set(['current-cohort-holdout','current-position-execution',...original,...reasons.map(r=>reasonTags[r.split(':')[0]!]??'measured-evidence-warning')])];
  if(tags.some(t=>!/^[a-z][a-z-]{0,31}$/.test(t)))throw new Error('INVALID_SCORE_FLAG');
  return tags.length<=16?tags:[...tags.slice(0,15),'more-evidence-flags'];
}

/** Patch measured fields together, then recompute and validate the exact frame/evidence binding. */
export function enrichMeasuredReview(built:ReviewInput,policy:Policy,
  measurements:ReadonlyMap<string,ReturnType<typeof measureAccountEvidence>>,
  executions:ReadonlyMap<string,{executionCoverage:number;executionFit:number}>,
  states:ReadonlyMap<string,ClearinghouseEvidence>):ReviewInput {
  for(const c of built.frame.candidates){
    const address=built.addresses.get(c.candidate)!,m=measurements.get(address),fit=executions.get(address);
    if(!m||!fit||!states.has(address))throw new Error('MISSING_MEASURED_FINALIST');
    Object.assign(c.metrics,m.metricPatch,{executionCoverage:fit.executionCoverage,executionFit:fit.executionFit});
    c.metrics.scoreFlags=measuredFlags(c.metrics.scoreFlags,m.reasons);
    const f=built.evidence.finalists.find(f=>f.candidate===c.candidate)!;
    Object.assign(f,{timeInMarket:c.metrics.timeInMarket,medianHoldMinutes:c.metrics.medianHoldMinutes,makerShare:c.metrics.makerShare,patterns:m.patterns});
    // Keep endpoints and spread curve points evenly; complete raw curves and all positions remain retained.
    const curve=[...f.equityCurve];let points=curve.length;
    const size=()=>new TextEncoder().encode(JSON.stringify({candidate:c.candidate,kind:c.kind,metrics:c.metrics,equityCurve:f.equityCurve,positions:f.positions,patterns:f.patterns})).length;
    while(size()>4096){
      if(points>26){points--;f.equityCurve=Array.from({length:points},(_,i)=>curve[Math.round(i*(curve.length-1)/(points-1))]!);}
      else if(f.positions.length)f.positions.pop();else throw new Error('MEASURED_FINALIST_EXCEEDS_BUDGET');
    }
  }
  for(const p of built.frame.pairs)p.currentExposureOverlap=currentExposureOverlap(states.get(built.addresses.get(p.a)!)!,states.get(built.addresses.get(p.b)!)!);
  built.frame.snapshotHash=snapshotCommitment(built.frame,built.addresses);
  built.committee=bindCommitteeEvidence(built.frame,policy,built.addresses,built.evidence);
  return built;
}

/** Uses the exact production compile gates; no replacement score or permissive diagnostic path. */
export function measuredDecisionDiagnostics(built:ReviewInput,policy:Policy,roleRows:Row[]=[],riskRows:Row[]=[]){
  const candidates=built.frame.candidates.map(c=>{
    const role=roleRows.find(r=>r.candidate===c.candidate),risk=riskRows.find(r=>r.candidate===c.candidate);
    const failures=candidateCompileFailures(c,policy,role,risk),bucketFit=role?.[policy.bucket.toLowerCase()+'Fit']??null;
    return {candidate:c.candidate,address:built.addresses.get(c.candidate),failedPrerequisites:failures,
      mandatoryPrerequisitesPassed:failures.length===0,bucketFit,positiveBucketFit:bucketFit!==null&&bucketFit>0,
      risk:risk?riskDecision(risk,policy):null};
  });
  const counts:Record<string,number>={};for(const c of candidates)for(const reason of c.failedPrerequisites)counts[reason]=(counts[reason]??0)+1;
  return {schema:'measured-compile-diagnostics.v1',implementation:'packages/backend/review/workflow.ts::candidateCompileFailures',
    scope:'Mandatory candidate gates plus bucket fit only. Pair compatibility, Red-Team and final capacity/policy assessment remain separate gates.',
    candidates,counts,mandatoryPassed:candidates.filter(c=>c.mandatoryPrerequisitesPassed).length};
}

export async function prepareMeasuredReview(directory:string) {
  const archiveVerification=verifyMeasuredArchive(directory);
  const input=read(join(directory,'input.json'));
  const markets=read(join(directory,'markets.json'));
  const data=input.addresses.map((a:string)=>read(join(directory,a+'.json')));
  const asOfMs=Date.now(),reads=data.map((d:any)=>d.reads.at(-1));
  const policy:Policy=read(new URL('../packages/backend/fixtures/frozen-configuration.json',import.meta.url).pathname).policy;
  const prepared=await buildMeasuredAssessment({sourceKind:'REAL_PUBLIC_API',sourceReads:reads,marketResponses:markets,asOfMs,maxReadAgeMs:600_000});
  const measurements=new Map<string,ReturnType<typeof measureAccountEvidence>>(),states=new Map<string,ClearinghouseEvidence>();
  const enriched:ScoreInput[]=input.inputs.map((original:ScoreInput)=>{
    const d=data.find((d:any)=>d.address===original.address),sample=d.reads.at(-1),c=stateEvidence(sample);
    const source={...original,...parsePortfolio(sample.portfolio),accountValue:c.accountValueUsd};
    const m=measureAccountEvidence({input:source,asOfMs:sample.completedAtMs,fills:d.fills,clearinghouse:c,
      leverageSamples:d.reads.filter((r:any)=>r.stateCoverage?.complete===true).map((r:any)=>{const s=stateEvidence(r);return{atMs:r.completedAtMs,equityUsd:s.accountValueUsd,
        grossNotionalUsd:s.positions.reduce((n,p)=>n+Math.abs(p.signedNotionalUsd),0),rawSha256:r.rawSha256};})});
    measurements.set(original.address,m);states.set(original.address,c);
    return{...source,...m.scorePatch};
  });
  const score=scoreCandidates(enriched),built=buildReviewInput({score:toFrameCandidates(score),inputs:enriched,
    positions:new Map([...measurements].map(([a,m])=>[a,[...m.positions].sort((x,y)=>Math.abs(y.signedNotionalUsd)-Math.abs(x.signedNotionalUsd)||x.market.localeCompare(y.market))])),policy,asOfMs,ttlMs:policy.maxFrameAgeMs});
  const execution:Record<string,ReturnType<typeof prepared.measureSourceExecution>>={};
  for(const c of built.frame.candidates){const address=built.addresses.get(c.candidate)!;execution[address]=prepared.measureSourceExecution(reads.find((r:any)=>r.address===address),policy);}
  enrichMeasuredReview(built,policy,measurements,new Map(Object.entries(execution)),states);
  const summary=built.frame.candidates.map(c=>({address:built.addresses.get(c.candidate),candidate:c.candidate,metrics:c.metrics,
    originalScoreFlags:score.candidates.find(s=>s.address===built.addresses.get(c.candidate))!.metrics!.flags,measurements:measurements.get(built.addresses.get(c.candidate)!)!.provenance,missing:measurements.get(built.addresses.get(c.candidate)!)!.reasons}));
  const bundle={schema:'measured-review-input.v1',sourceKind:'REAL_PUBLIC_API',economicAuthority:false,asOfMs,archiveVerification,
    sourceIngest:{artifactHash:input.artifactHash,runId:input.runId,asOfMs:input.inputAsOfMs},
    selectionScope:'measured finalists from the initial strict Top100; re-ranked within measured subset',
    policy,frame:built.frame,evidence:built.evidence,addresses:[...built.addresses],summary,execution,
    sourceReads:reads,marketResponses:markets,provenance:prepared.provenance};
  save(join(directory,'review-input.json'),bundle);
  save(join(directory,'funnel.json'),{generatedAt:asOfMs,steps:[{stage:'acquired',label:'Initial Top100 collection',count:100},
    {stage:'measured',label:'Measured finalists',count:enriched.length},{stage:'strict',label:'Strict Score eligible',count:score.candidates.filter(c=>c.eligible).length},
    {stage:'finalists',label:'Review input',count:built.frame.candidates.length}],finalists:built.frame.candidates.map(c=>{
      const address=built.addresses.get(c.candidate)!;const s=score.candidates.find(s=>s.address===address)!;
      return{address,kind:s.kind,score:s.score,picked:false,rationale:'Real public data; research/Review input, not frozen.'};})});
  return {bundle,built,score,prepared,measurements};
}

export async function runMeasuredReview(directory:string,algorithm:'return-first'|'drawdown-first') {
  const {bundle,built,prepared,score}=await prepareMeasuredReview(directory);
  const now=Date.now(),out=join(directory,algorithm+'-'+now);mkdirSync(out,{recursive:true});
  const db=new PGlite(join(out,'postgres'));
  try{
    await db.exec('create role anon; create role authenticated; create role service_role bypassrls;');
    for(const f of ['20261006130000_review_audit.sql','20261006140000_paper_review.sql'])await db.exec(readFileSync(new URL('../supabase/migrations/'+f,import.meta.url),'utf8'));
    const rpc:Rpc={async call(name,args){if(!/^[a-z_]+$/.test(name)||Object.keys(args).some(k=>!/^[a-z_]+$/.test(k)))throw new Error('INVALID_RPC');
      return(await db.query<{value:unknown}>(`select ${name}(${Object.keys(args).map((k,i)=>`${k} => $${i+1}`).join(',')}) as value`,Object.values(args).map(v=>typeof v==='object'?JSON.stringify(v):v))).rows[0].value;}};
    const prompts={role:`Measured ${algorithm} deterministic ranking v1; no AI claims`,risk:'Measured drawdown/leverage/evidence flags v1',redteam:'No additional model penalty; deterministic capacity assessment remains mandatory v1'};
    const modelConfigHash=commitment('perpparrot:measured-rule:v1',{algorithm,version:1});
    const binding=(stage:keyof typeof prompts,evidenceHash:string)=>({nodeId:'measured-rule',schemaVersion:'1.1.0' as const,snapshotHash:built.frame.snapshotHash,policyHash:built.frame.policyHash,
      promptHash:commitment('perpparrot:prompt:v1',prompts[stage]),modelConfigHash,evidenceHash});
    const ordered=[...built.frame.candidates].sort((a,b)=>algorithm==='drawdown-first'?a.metrics.maxDrawdown-b.metrics.maxDrawdown||a.candidate-b.candidate
      :(score.candidates.find(c=>c.address===built.addresses.get(b.candidate))?.metrics?.periodReturn??-Infinity)
        -(score.candidates.find(c=>c.address===built.addresses.get(a.candidate))?.metrics?.periodReturn??-Infinity)||a.candidate-b.candidate);
    const deps:CommitteeDependencies={quorum:1,nodeIds:['measured-rule'],agentTimeoutMs:60_000,clock:Date.now,modelConfigHash,
      rolePromptHash:commitment('perpparrot:prompt:v1',prompts.role),riskPromptHash:commitment('perpparrot:prompt:v1',prompts.risk),redTeamPromptHash:commitment('perpparrot:prompt:v1',prompts.redteam),
      role:async e=>[{...binding('role',e.evidenceHash),results:built.frame.candidates.map(c=>{
        const fit=Math.max(1,100-ordered.findIndex(x=>x.candidate===c.candidate)*3);
        return{candidate:c.candidate,preserver:fit,compounder:fit,diversifier:fit,directional:fit,opportunistic:fit,convexity:0,reject:0,
          conservativeFit:fit,balancedFit:fit,aggressiveFit:fit,confidence:80};})}],
      risk:async e=>[{...binding('risk',e.evidenceHash),results:built.frame.candidates.map(c=>({candidate:c.candidate,
        drawdownRisk:Math.min(100,Math.round(c.metrics.maxDrawdown*100)),leverageRisk:c.metrics.averageLeverage===null?100:Math.min(100,Math.round(c.metrics.averageLeverage*10)),
        concentrationRisk:Math.round((c.metrics.concentration??1)*50),pathRisk:Math.round(c.metrics.maxDrawdown*100),
        executionRisk:100-(c.metrics.executionFit??0),evidenceRisk:50,confidence:80})) as Row[]}],
      redTeam:async i=>[{...binding('redteam',i.evidence.evidenceHash),draftHash:i.draftHash,rebuildScore:0,portfolioRisk:50,
        penalties:i.sources.map(s=>({candidate:s.candidate,multiplier:1,excludeScore:0}))}],
      assess:prepared.assess,audit:committeeAudit(rpc,algorithm,prompts,Date.now)};
    const store=new SupabasePaperStore(rpc),session='measured:'+algorithm+':'+bundle.frame.snapshotHash;
    const result=await reviewPaperSession({session,frame:built.frame,policy:bundle.policy,addresses:built.addresses,rich:built.evidence,nowMs:Date.now()},store,deps,async()=>{throw new Error('UNEXPECTED_MONITOR');});
    if(result.phase!=='REVIEW')throw new Error('EXPECTED_REVIEW');
    const receipt=result.receipt;
    save(join(out,'receipt.json'),receipt);
    const audit=(await db.query<{output:{promptHash:string;results?:Row[]}}>('select * from review_audit order by id')).rows;
    save(join(out,'audit.json'),audit);
    const diagnostics=measuredDecisionDiagnostics(built,bundle.policy,audit.find(r=>r.output.promptHash===deps.rolePromptHash)?.output.results,audit.find(r=>r.output.promptHash===deps.riskPromptHash)?.output.results);
    save(join(out,'decision-diagnostics.json'),diagnostics);
    const summary:any={schema:'measured-integration.v1',sourceKind:'REAL_PUBLIC_API',provider:'DETERMINISTIC_RULES',economicAuthority:false,
      algorithm,sourceIngest:bundle.sourceIngest,decisionDiagnostics:diagnostics,frameHash:built.frame.snapshotHash,evidenceHash:built.committee.evidenceHash,
      reviewStatus:receipt.manifest.status,reason:receipt.manifest.reason,sourceCount:receipt.manifest.sources.length,receiptHash:receipt.receiptHash,completedAt:Date.now(),service:null};
    if(receipt.manifest.status==='VALID'&&receipt.manifest.sources.length>=5){
      // Explicit unfunded paper identity; never write packages/backend/frozen/live.json.
      const cfg=await freezePaperSession(store,session,receipt.receiptHash,'0x0000000000000000000000000000000000000001',999,Date.now());
      save(join(out,'frozen-paper.json'),cfg);
      summary.service=await runMeasuredService({sourceKind:'REAL_PUBLIC_API',outPath:join(out,'service'),configuration:cfg as unknown as ServiceConfiguration,
        sourceReads:bundle.sourceReads.filter((r:any)=>cfg.sources.some(s=>s.sourceAddress===r.address)),marketResponses:bundle.marketResponses,asOfMs:Date.now(),maxReadAgeMs:600_000});
    }else summary.blocked=receipt.manifest.status!=='VALID'?receipt.manifest.reason:'FREEZE_REQUIRES_AT_LEAST_FIVE_SOURCES';
    save(join(out,'summary.json'),summary);save(join(directory,algorithm+'-latest.json'),{out,...summary});return summary;
  }finally{await db.close();}
}
if(import.meta.main){const{values}=parseArgs({options:{data:{type:'string',default:'night-shift-integration/out/measured'},prepare:{type:'boolean',default:false},algorithm:{type:'string',default:'return-first'}}});
  if(values.prepare){const x=await prepareMeasuredReview(resolve(values.data!));console.log(JSON.stringify({prepared:true,candidates:x.built.frame.candidates.length}));}
  else{if(!['return-first','drawdown-first'].includes(values.algorithm!))throw new Error('invalid algorithm');console.log(JSON.stringify(await runMeasuredReview(resolve(values.data!),values.algorithm as 'return-first'|'drawdown-first')));}}

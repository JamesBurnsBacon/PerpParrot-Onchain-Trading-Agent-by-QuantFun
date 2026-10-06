import { PGlite } from '@electric-sql/pglite';
import { readFileSync, writeFileSync } from 'node:fs';
import { paperFixture, NOW } from '../tests/support/paper-lifecycle-fixture.ts';
import { scoreCandidates } from '../packages/backend/src/score/score.ts';
import { toFrameCandidates } from '../packages/backend/src/score/frame.ts';
import { buildReviewInput } from '../packages/backend/review/input.ts';
import { reviewPaperSession, freezePaperSession } from '../packages/backend/review/paper/lifecycle.ts';
import { SupabasePaperStore } from '../packages/backend/review/paper/store.ts';
import { committeeAudit } from '../packages/backend/review/committee-audit.ts';
import { commitment, policyCommitment, snapshotCommitment } from '../packages/shared/src/commitments.ts';
import { keccakUtf8 } from '../packages/backend/src/snapshot.ts';
import { parseTargets } from '../packages/executor/src/targets.ts';
import { runServiceProof } from './service-loop.ts';
import { computeExposures, targetsFromSnapshot, checkActiveCeilings, decToE6, type WeightedSource } from '../packages/shared/copy.ts';
import { planOrders, type Market } from '../packages/executor/src/planner.ts';
import type { ScoreInput } from '../packages/backend/src/score/types.ts';
import type { Rpc } from '../packages/backend/review/supabase.ts';
import type { Row, Source } from '../packages/shared/src/contracts.ts';
import type { PositionsSnapshot } from '../packages/shared/snapshot.ts';
import { allocate, candidates, history, DAY } from './algorithms.ts';
import { digest, type Algorithm } from './contracts.ts';

// Fully synthetic contract probe. Real-account missing fields are never filled with these values.
export async function probeModules(path: string, algorithm: Algorithm, nowMs: number) {
  let db = new PGlite(path);
  const exists = (await db.query<{name: string | null}>("select to_regclass('public.paper_sessions')::text as name")).rows[0].name;
  if (!exists) {
    await db.exec('create role anon; create role authenticated; create role service_role bypassrls;');
    for (const file of ['20261006130000_review_audit.sql', '20261006140000_paper_review.sql'])
      await db.exec(readFileSync(new URL('../supabase/migrations/' + file, import.meta.url), 'utf8'));
  }
  const rpc: Rpc = {async call(name, args) {
    if (!/^[a-z_]+$/.test(name) || Object.keys(args).some(k => !/^[a-z_]+$/.test(k))) throw new Error('INVALID_RPC');
    const keys = Object.keys(args);
    return (await db.query<{value: unknown}>(`select ${name}(${keys.map((k, i) => `${k} => $${i + 1}`).join(',')}) as value`,
      Object.values(args).map(v => typeof v === 'object' ? JSON.stringify(v) : v))).rows[0].value;
  }};
  try {
    const f = paperFixture(rpc), shift = nowMs - NOW;
    const addresses = [...f.input.addresses.values()];
    const inputs: ScoreInput[] = addresses.map((address, j) => {
      const accountValueHistory: [number, number][] = [], pnlHistory: [number, number][] = [];
      for (let i = 0; i <= 90; i++) {
        const ts = nowMs - 1000 - (90 - i) * DAY;
        const pnl = 100_000 * (0.0008 * i + 0.01 * Math.sin(i * (0.4 + j * 0.35)));
        accountValueHistory.push([ts, 100_000 + pnl]); pnlHistory.push([ts, pnl]);
      }
      return {address,kind:'trader',accountValue:accountValueHistory.at(-1)![1],closed:false,
        month:{accountValueHistory:accountValueHistory.slice(-31),pnlHistory:pnlHistory.slice(-31)},
        allTime:{accountValueHistory,pnlHistory},history:null,tradeCount:100,
        avgLeverage:1,timeInMarket:0.8,makerShare:0.5,medianHoldHours:8};
    });
    const score = scoreCandidates(inputs); // Production Score, no relaxed filters.
    if (score.finalists.length !== 5) throw new Error('CONTROL_SCORE_NEEDS_FIVE_FINALISTS');
    const selected = allocate(candidates(inputs.map(i => history(i)!), nowMs), algorithm, nowMs);
    if (selected.sources.length !== 5) throw new Error('CONTROL_ALLOCATION_EMPTY');
    const assets = ['BTC', 'ETH', 'SOL', 'AVAX', 'HYPE'];
    const marks = [100_000, 2500, 150, 30, 30];
    const markets = new Map<string, Market>(assets.map((name, i) => [name,
      {name,assetId:i,szDecimals:[5,4,2,1,2][i],maxLeverage:10,markPx:marks[i],tradable:true}]));
    const positions = new Map(addresses.map((address, i) => [address,
      [{market:assets[i],signedNotionalUsd:100_000,leverage:1,liquidationDistance:0.5}]]));
    const built = buildReviewInput({score:toFrameCandidates(score),inputs,positions,
      policy:f.input.policy,asOfMs:nowMs-1000,ttlMs:11000});
    // Explicit scenario evidence supplies only the fields production ingestion lacks.
    // The artifact below lists these fixtures. This never updates real ScoreInput files.
    for (const c of built.frame.candidates) Object.assign(c.metrics, {
      oosWindows:2,oosSharpe:1,oosSortino:1,oosMaxDrawdown:0.1,crossWindowStability:0.8,
      survivorshipQuality:'CURRENT_SNAPSHOT',executionCoverage:1,executionFit:90,
      concentration:1,liquidationDistance:0.5,btcBeta:null,
    });
    for (const pair of built.frame.pairs) {pair.correlation=0.2;pair.currentExposureOverlap=0;pair.linkedSource=false;}
    for (const pair of built.evidence.pairs) {pair.correlation=0.2;pair.linkedSource=false;}
    built.frame.policyHash = policyCommitment(f.input.policy);
    built.frame.snapshotHash = snapshotCommitment(built.frame, built.addresses);
    const input = {session:'night:' + algorithm.replaceAll('.', '-'),frame:built.frame,policy:f.input.policy,addresses:built.addresses,rich:built.evidence,nowMs};
    const snapshotSources = addresses.map((address, i) => ({address,
      equityE6:decToE6(String(inputs[i].accountValue)).toString(),positions:[{asset:assets[i],notionalE6:decToE6('100000').toString()}]}));
    const weighted = (sources: readonly Source[]): WeightedSource[] => sources.map(s => ({
      ...snapshotSources.find(x => x.address === s.sourceAddress)!,weightE6:Math.floor(s.weight*1e6),ceilingE6:Math.floor(s.maxAllocation*1e6)}));
    const prompts = {role:'Deterministic equal-weight selection v1',risk:'Deterministic fixture risk v1',redteam:'Deterministic fixture portfolio check v1'};
    const modelConfigHash = commitment('perpparrot:night-rule:v1', {algorithm,provider:'local-rules',fixture:true});
    let calls = 0;
    const binding = (stage: keyof typeof prompts, evidenceHash: string) => ({nodeId:'local-0',schemaVersion:'1.1.0' as const,
      snapshotHash:built.frame.snapshotHash,policyHash:built.frame.policyHash,promptHash:commitment('perpparrot:prompt:v1',prompts[stage]),modelConfigHash,evidenceHash});
    const deps = {...f.deps,clock:()=>nowMs,quorum:1,nodeIds:['local-0'],modelConfigHash,
      rolePromptHash:commitment('perpparrot:prompt:v1',prompts.role),riskPromptHash:commitment('perpparrot:prompt:v1',prompts.risk),redTeamPromptHash:commitment('perpparrot:prompt:v1',prompts.redteam),
      role:async (e: any) => {calls++; return [{...binding('role', e.evidenceHash),results:built.frame.candidates.map(c => {
        const picked = selected.sources.some(s => s.address === built.addresses.get(c.candidate));
        return {candidate:c.candidate,preserver:80,compounder:80,diversifier:80,directional:50,opportunistic:50,convexity:0,
          reject:picked?0:100,conservativeFit:80,balancedFit:80,aggressiveFit:80,confidence:90};
      })}];},
      risk:async (e: any) => {calls++;return [{...binding('risk',e.evidenceHash),results:built.frame.candidates.map(c => ({candidate:c.candidate,
        drawdownRisk:20,leverageRisk:20,concentrationRisk:20,pathRisk:20,executionRisk:20,evidenceRisk:20,confidence:90}))}];},
      redTeam:async (i: any) => {calls++;return [{...binding('redteam',i.evidence.evidenceHash),draftHash:i.draftHash,rebuildScore:0,portfolioRisk:20,
        penalties:i.sources.map((s: Source)=>({candidate:s.candidate,multiplier:1,excludeScore:0}))}];},
      assess:(sources: readonly Source[]) => {
        const rows=weighted(sources); checkActiveCeilings(rows);
        const exposures=computeExposures(rows), targets=new Map(exposures.map(e=>[e.asset,Number(e.exposureE9)/1e9*input.policy.capitalUsd]));
        const plan=planOrders(targets,{equityUsd:input.policy.capitalUsd,positions:new Map()},markets,{minOrderUsd:10,driftFraction:0.1,marginCap:0.95,slippageBps:50});
        const grossBound=sources.reduce((n,s)=>n+s.weight,0)*Math.max(...rows.map(r=>Number(r.positions[0].notionalE6)/Number(r.equityE6)));
        return {executableTargets:plan.orders.length,grossLeverage:grossBound,withinPolicy:plan.marginScale===1&&grossBound<=input.policy.maxGrossLeverage};
      },audit:committeeAudit(rpc,algorithm,prompts,()=>nowMs),
    };
    const store=new SupabasePaperStore(rpc), saved=await store.load(input.session);
    const result= saved.review ? {phase:'REVIEW' as const,receipt:saved.review} : await reviewPaperSession(input,store,deps,async()=>{throw new Error('unexpected monitor');});
    if(result.phase!=='REVIEW'||result.receipt.manifest.status!=='VALID')throw new Error('CONTROL_REVIEW_FAILED:'+JSON.stringify(result));
    const configuration=await freezePaperSession(store,input.session,result.receipt.receiptHash,f.account,999,nowMs);
    await db.close();db=new PGlite(path);
    const restarted=new SupabasePaperStore(rpc);
    if((await restarted.load(input.session)).configuration?.configurationHash!==configuration.configurationHash)throw new Error('RESTART_LOST_FREEZE');
    const monitored=await reviewPaperSession(input,restarted,deps,async e=>({evidenceHash:e.evidenceHash,concerns:[]}));
    if(monitored.phase!=='MONITOR')throw new Error('FROZEN_SESSION_RESELECTED');
    const snapshot: PositionsSnapshot={snapshotId:'night-'+digest({algorithm,nowMs}).slice(0,16),runAt:nowMs/1000,takenAt:nowMs/1000,
      configuration:configuration as unknown as PositionsSnapshot['configuration'],eligibleAssets:assets,sources:snapshotSources.sort((a,b)=>a.address.localeCompare(b.address))};
    const exposures=targetsFromSnapshot(snapshot);
    const wire={runId:`mirror-${snapshot.runAt}`,runAt:snapshot.runAt,snapshotHash:keccakUtf8(JSON.stringify(snapshot)),
      configurationHash:configuration.configurationHash,account:f.account,
      exposures:exposures.map(e=>({asset:e.asset,exposureE9:e.exposureE9.toString()}))};
    const decoded=parseTargets(wire,snapshot.runAt);
    const plan=planOrders(new Map(decoded.exposures.map(e=>[e.asset,Number(e.exposureE9)/1e9*1000])),
      {equityUsd:1000,positions:new Map()},markets,{minOrderUsd:10,driftFraction:0.1,marginCap:0.95,slippageBps:50});
    if(plan.orders.length!==5)throw new Error('EXPECTED_FIVE_PLANNED_ORDERS');
    let rejected=0;
    const ineligible=structuredClone(snapshot);ineligible.eligibleAssets=[];
    const unknownSource=structuredClone(snapshot);unknownSource.sources[0].address='0x'+'f'.repeat(40);
    for(const bad of [ineligible,unknownSource])try{targetsFromSnapshot(bad);}catch{rejected++;}
    if(rejected!==2)throw new Error('TARGET_GUARD_REGRESSION');
    const serviceProof=await runServiceProof(path+'-services',{configuration:snapshot.configuration,snapshot});
    const auditRows=Number((await db.query<{count:number}>('select count(*)::int as count from review_audit')).rows[0].count);
    writeFileSync(path+'-review-evidence.json',JSON.stringify({sourceKind:'SYNTHETIC_FIXTURE',economicAuthority:false,
      receipt:result.receipt,configuration,audit:(await db.query('select * from review_audit order by id')).rows},null,2)+'\n');
    return {schemaVersion:'night-module-probe.v2',sourceKind:'SYNTHETIC_FIXTURE',economicAuthority:false,
      algorithm,score:{inputs:inputs.length,eligible:score.candidates.filter(c=>c.eligible).length,finalists:score.finalists.length},
      allocation:selected,reviewStatus:result.receipt.manifest.status,reviewReceiptHash:result.receipt.receiptHash,
      configurationHash:configuration.configurationHash,fixtureAccount:f.account,auditRows,
      databaseRestartVerified:true,afterFreezePhase:monitored.phase,targetGuardsRejected:rejected,
      targetsRoundtrip:decoded.configurationHash===configuration.configurationHash,serviceProof,
      plan,fixtureFields:['synthetic portfolios and identities','OOS evidence','positions, markets and execution state','correlation','deterministic Role/Risk/Red-Team outputs'],
      reusedModules:['scoreCandidates','toFrameCandidates','buildReviewInput','runCommitteeReview','SupabasePaperStore','freezePaperSession','targetsFromSnapshot','parseTargets','Runner','SnapshotService','createApp','PgStore','planOrders']};
  } finally {await db.close();}
}

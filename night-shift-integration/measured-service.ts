import {PGlite} from '@electric-sql/pglite';
import {mkdirSync,mkdtempSync,readFileSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import type {SQL} from 'bun';
import {z} from 'zod';
import {SnapshotService} from '../packages/backend/src/service.ts';
import {EligibilityTracker,openInterestFromMeta,applyHysteresis} from '../packages/backend/src/eligibility.ts';
import {PostgresSnapshotStore,PostgresEligibilityStore,PostgresPaperStore} from '../packages/backend/src/pg-store.ts';
import {PaperService,type BookSpec} from '../packages/backend/src/paper/service.ts';
import {FileConfigurationSource} from '../packages/backend/src/configuration-source.ts';
import {keccakUtf8} from '../packages/backend/src/snapshot.ts';
import type {HlReader} from '../packages/backend/src/hyperliquid.ts';
import {PostgresStore} from '../packages/executor/src/pg-store.ts';
import {Runner} from '../packages/executor/src/runner.ts';
import {createApp} from '../packages/executor/src/app.ts';
import {createExchange} from '../packages/executor/src/exchange.ts';
import {backendTargets} from '../packages/executor/src/targets.ts';
import {loadMarkets,type InfoFn} from '../packages/executor/src/hyperliquid.ts';
import {planOrders} from '../packages/executor/src/planner.ts';
import type {RunRecord} from '../packages/executor/src/store.ts';
import {readAccountState,type PerpState,type PortfolioResponse} from '../packages/shared/account.ts';
import {computeExposures,checkActiveCeilings,capGrossExposure,targetsFromSnapshot,type WeightedSource} from '../packages/shared/copy.ts';
import type {FrozenConfiguration} from '../packages/shared/frozen.ts';
import type {PositionsSnapshot} from '../packages/shared/snapshot.ts';
import type {Source,Frame,Policy} from '../packages/shared/src/contracts.ts';
import type {Assessment} from '../packages/backend/review/workflow.ts';
import {digest} from './contracts.ts';

export type SourceRead={address:string;portfolio:unknown;states:[unknown,unknown];startedAtMs:number;completedAtMs:number;allStates?:{dex:string;state:unknown;rawSha256?:string;startedAtMs:number;completedAtMs:number}[];stateCoverage?:{declaredDexes:string[];requestedDexes:string[];complete:boolean}};
export type MarketResponses={perpDexs:unknown;core:unknown;xyz:unknown;startedAtMs:number;completedAtMs:number};
export type MeasuredContextInput={sourceKind:'REAL_PUBLIC_API'|'SYNTHETIC_FIXTURE';sourceReads:SourceRead[];marketResponses:MarketResponses;asOfMs:number;maxReadAgeMs?:number};
const address=/^0x[0-9a-f]{40}$/;
const decimal=z.string().regex(/^-?\d+(?:\.\d+)?$/);
const position=z.object({coin:z.string().min(1),szi:decimal,positionValue:decimal}).passthrough();
const stateSchema=z.object({assetPositions:z.array(z.object({position}).passthrough())}).passthrough();
const portfolioSchema=z.array(z.tuple([z.string(),z.object({accountValueHistory:z.array(z.tuple([z.number().int().nonnegative(),decimal]))}).passthrough()]));
const metaSchema=z.tuple([z.object({collateralToken:z.number().int().nonnegative(),universe:z.array(z.object({name:z.string(),szDecimals:z.number().int().min(0).max(10),maxLeverage:z.number().finite().positive(),isDelisted:z.boolean().optional(),onlyIsolated:z.boolean().optional(),marginMode:z.string().optional()}).passthrough())}).passthrough(),z.array(z.object({markPx:z.string().nullable(),openInterest:decimal,funding:decimal.optional()}).passthrough())]);
const json=(v:unknown)=>JSON.stringify(v,(_k,x)=>typeof x==='bigint'?x.toString():x);
function ensure(ok:unknown,message:string):asserts ok{if(!ok)throw Error('MEASURED_SERVICE: '+message);}
function readWindow(start:number,end:number,asOf:number,maxAge:number){ensure(Number.isSafeInteger(start)&&Number.isSafeInteger(end)&&start<=end&&end<=asOf&&asOf-start<=maxAge,'stale/future/invalid measured read window');}
function prepare(input:MeasuredContextInput){
 const owned=structuredClone(input),asOfMs=owned.asOfMs,maxReadAgeMs=owned.maxReadAgeMs??120_000;
 ensure(Number.isSafeInteger(asOfMs)&&asOfMs>0&&Number.isSafeInteger(maxReadAgeMs)&&maxReadAgeMs>=1&&maxReadAgeMs<=3_600_000,'invalid measurement clock/age bound');
 const response=owned.marketResponses;readWindow(response.startedAtMs,response.completedAtMs,asOfMs,maxReadAgeMs);
 const core=metaSchema.parse(response.core),xyz=metaSchema.parse(response.xyz);
 const dexes=z.array(z.object({name:z.string()}).passthrough().nullable()).parse(response.perpDexs);
 ensure(dexes.some(d=>d?.name==='xyz'),'measured xyz metadata missing');
 for(const pair of [core,xyz]){ensure(pair[0].universe.length===pair[1].length,'metadata/context lengths disagree');ensure(new Set(pair[0].universe.map(x=>x.name)).size===pair[0].universe.length,'duplicate market metadata');for(const c of pair[1])ensure(Number.isFinite(Number(c.openInterest))&&Number(c.openInterest)>=0&&(c.markPx===null||(Number.isFinite(Number(c.markPx))&&Number(c.markPx)>=0)),'invalid measured market value');}
 const map=new Map<string,SourceRead>();
 for(const row of owned.sourceReads){
  ensure(address.test(row.address)&&!map.has(row.address),'invalid/duplicate measured source');readWindow(row.startedAtMs,row.completedAtMs,asOfMs,maxReadAgeMs);
  ensure(Array.isArray(row.states)&&row.states.length===2,'both source dex reads required');const states=row.states.map(s=>stateSchema.parse(s));
  let observedStates=states;
  if(row.allStates){
   ensure(row.allStates.length>=2&&new Set(row.allStates.map(s=>s.dex)).size===row.allStates.length,'duplicate/incomplete all-dex evidence');
   observedStates=row.allStates.map(s=>{readWindow(s.startedAtMs,s.completedAtMs,asOfMs,maxReadAgeMs);ensure(s.startedAtMs>=row.startedAtMs&&s.completedAtMs<=row.completedAtMs,'all-dex read outside source window');return stateSchema.parse(s.state);});
   ensure(digest(row.allStates.find(s=>s.dex==='')?.state)===digest(row.states[0])&&digest(row.allStates.find(s=>s.dex==='xyz')?.state)===digest(row.states[1]),'core/xyz differ from all-dex evidence');
   if(row.stateCoverage){const coverage=row.stateCoverage;ensure(new Set(coverage.requestedDexes).size===coverage.requestedDexes.length&&new Set(coverage.declaredDexes).size===coverage.declaredDexes.length&&coverage.requestedDexes.length===row.allStates.length&&coverage.requestedDexes.every(d=>row.allStates!.some(s=>s.dex===d)),'declared/requested dex evidence mismatch');ensure(['',...dexes.flatMap(d=>d?[d.name]:[])].every(d=>coverage.declaredDexes.includes(d)),'coverage omits a measured declared dex');ensure(coverage.complete===coverage.declaredDexes.every(d=>coverage.requestedDexes.includes(d)),'inconsistent all-dex coverage flag');}
  }else ensure(!row.stateCoverage,'coverage requires all-dex evidence');
  for(const s of observedStates)for(const {position:p} of s.assetPositions)ensure(Number.isFinite(Number(p.szi))&&Number(p.szi)!==0&&Number.isFinite(Number(p.positionValue))&&Number(p.positionValue)>=0,'invalid measured position');
  const portfolio=portfolioSchema.parse(row.portfolio),day=portfolio.find(([key])=>key==='day')?.[1].accountValueHistory;ensure(day?.length,'measured day portfolio required');
  const end=day.at(-1)!;ensure(end[0]<=row.completedAtMs&&asOfMs-end[0]<=maxReadAgeMs&&Number(end[1])>0,'source equity must be fresh and positive');
  readAccountState(states as PerpState[],portfolio as PortfolioResponse,new Set());map.set(row.address,row);
 }
 ensure(map.size>0,'measured sources missing');
 const oiPair=(pair:z.infer<typeof metaSchema>)=>{const indices=pair[0].universe.map((_,i)=>i).filter(i=>pair[1][i].markPx!==null);return openInterestFromMeta([{...pair[0],universe:indices.map(i=>pair[0].universe[i])},indices.map(i=>({...pair[1][i],markPx:pair[1][i].markPx!}))]);};
 const oi=new Map([...oiPair(core),...oiPair(xyz)]),eligibleAssets=applyHysteresis(oi,new Set());ensure(eligibleAssets.length>0,'no eligible measured markets');
 ensure(['REAL_PUBLIC_API','SYNTHETIC_FIXTURE'].includes(owned.sourceKind),'source provenance marker missing');
 const provenance={schemaVersion:'measured-upstream-cache.v1',sourceKind:owned.sourceKind,dataKind:owned.sourceKind==='REAL_PUBLIC_API'?'measured-public-api-responses':'synthetic-fixture-responses',asOfMs,maxReadAgeMs,
  sourceReads:owned.sourceReads.map(r=>({address:r.address,startedAtMs:r.startedAtMs,completedAtMs:r.completedAtMs,portfolioObjectSha256:digest(r.portfolio),coreStateObjectSha256:digest(r.states[0]),xyzStateObjectSha256:digest(r.states[1]),...(r.allStates?{allDexStatesObjectSha256:digest(r.allStates),stateCoverage:r.stateCoverage??null}:{})})).sort((a,b)=>a.address.localeCompare(b.address)),
  markets:{startedAtMs:response.startedAtMs,completedAtMs:response.completedAtMs,perpDexsObjectSha256:digest(response.perpDexs),coreObjectSha256:digest(response.core),xyzObjectSha256:digest(response.xyz)},
  convention:'SHA-256 of canonical parsed JSON, not original HTTP response bytes; original timestamps retained.'};
 const marketInfo:InfoFn=async<T>(request:Record<string,unknown>):Promise<T>=>{
  if(request.type==='perpDexs')return structuredClone(response.perpDexs) as T;
  if(request.type==='metaAndAssetCtxs'){ensure(request.dex===undefined||request.dex===''||request.dex==='xyz','unmeasured dex');return structuredClone(request.dex==='xyz'?response.xyz:response.core) as T;}
  throw Error('MEASURED_SERVICE: unmeasured market request');
 };
 const hl:HlReader={async perp(user,dex){const r=map.get(user);ensure(r,'unmeasured source');ensure(dex===''||dex==='xyz','unmeasured dex');return structuredClone(r.states[dex==='xyz'?1:0]) as PerpState;},async portfolio(user){const r=map.get(user);ensure(r,'unmeasured source');return structuredClone(r.portfolio) as PortfolioResponse;}};
 const sourceStates=new Map([...map].map(([a,r])=>[a,readAccountState(r.states as PerpState[],r.portfolio as PortfolioResponse,new Set(eligibleAssets))]));
 return {owned,map,sourceStates,core,xyz,oi,eligibleAssets,marketInfo,hl,provenance,asOfMs};
}
/** Synchronous final assessment over prefetched, immutable real reads. No provider/exchange calls. */
export async function buildMeasuredAssessment(input:MeasuredContextInput){
 const context=prepare(input),markets=await loadMarkets(context.marketInfo);
 const assess=(sources:readonly Source[],_frame:Frame,policy:Policy):Assessment=>{
  try{
   ensure(Number.isFinite(policy.capitalUsd)&&policy.capitalUsd>0,'invalid paper capital');const seen=new Set<string>();
   const rows:WeightedSource[]=sources.map(s=>{ensure(!seen.has(s.sourceAddress)&&Number.isFinite(s.weight)&&s.weight>0&&s.weight<=s.maxAllocation,'invalid selected source');seen.add(s.sourceAddress);const measured=context.sourceStates.get(s.sourceAddress);ensure(measured&&measured.equityE6>0n,'missing selected source measurement');return {address:s.sourceAddress,equityE6:measured.equityE6.toString(),positions:[...measured.positions].map(([asset,n])=>({asset,notionalE6:n.toString()})),weightE6:Math.floor(s.weight*1e6),ceilingE6:Math.floor(s.maxAllocation*1e6)};});
   checkActiveCeilings(rows);const current=computeExposures(rows),gross=current.reduce((n,x)=>n+Math.abs(Number(x.exposureE9)/1e9),0),allocated=rows.reduce((n,s)=>n+s.weightE6/1e6,0);
   // Conservative triangle bound for every possible active-source subset before netting.
   const worst=allocated*Math.max(0,...rows.map(s=>s.positions.reduce((n,p)=>n+Math.abs(Number(p.notionalE6))/Number(s.equityE6),0)));
   const capped=capGrossExposure(current,BigInt(Math.floor(policy.maxGrossLeverage*1e9)));
   const plan=planOrders(new Map(capped.map(e=>[e.asset,Number(e.exposureE9)/1e9*policy.capitalUsd])),{equityUsd:policy.capitalUsd,positions:new Map()},markets,{minOrderUsd:10,driftFraction:0.1,marginCap:0.95,slippageBps:50});
   const bound=Math.max(gross,worst);return {executableTargets:plan.orders.length,grossLeverage:bound,withinPolicy:Number.isFinite(bound)&&bound<=policy.maxGrossLeverage&&plan.marginScale===1&&plan.skipped.every(s=>!['UNKNOWN_MARKET','NOT_TRADABLE'].includes(s.reason))};
  }catch{return {executableTargets:0,grossLeverage:0,withinPolicy:false};}
 };
 const measureSourceExecution=(read:SourceRead,policy:Policy)=>{
  const saved=context.map.get(read.address);ensure(saved&&digest(saved)===digest(read),'execution source differs from captured evidence');
  ensure(Number.isFinite(policy.capitalUsd)&&policy.capitalUsd>0&&Number.isFinite(policy.maxSourceWeight)&&policy.maxSourceWeight>0,'invalid hypothetical allocation');
  const observedStates=(saved.allStates?.map(s=>s.state)??saved.states) as PerpState[];
  const allAssets=new Set(observedStates.flatMap(s=>s.assetPositions.map(p=>p.position.coin)));
  const full=readAccountState(observedStates,saved.portfolio as PortfolioResponse,allAssets),eligible=new Set(context.eligibleAssets);
  let gross=0,covered=0;const targets=new Map<string,number>();
  for(const [asset,n] of full.positions){const notional=Math.abs(Number(n)/1e6);gross+=notional;
   if(eligible.has(asset)&&markets.get(asset)?.tradable){covered+=notional;targets.set(asset,Number(n)/Number(full.equityE6)*policy.maxSourceWeight*policy.capitalUsd);}}
  const requested=gross/(Number(full.equityE6)/1e6)*policy.maxSourceWeight*policy.capitalUsd;
  const plan=planOrders(targets,{equityUsd:policy.capitalUsd,positions:new Map()},markets,{minOrderUsd:10,driftFraction:0.1,marginCap:0.95,slippageBps:50});
  const executable=plan.orders.reduce((n,o)=>n+Math.min(Math.abs(o.targetUsd),Math.abs(o.notionalUsd)),0);
  return {address:read.address,scope:'CURRENT_POSITION_PLANNER' as const,horizon:'single captured position snapshot',
   coverageScope:saved.allStates?'ALL_OBSERVED_DEXES':'CORE_XYZ_ONLY',stateCoverageComplete:saved.stateCoverage?.complete??null,
   executionCoverage:saved.stateCoverage?.complete===false?0:gross>0?Math.min(1,covered/gross):0,
   executionFit:saved.stateCoverage?.complete!==false&&requested>0&&plan.marginScale===1?Math.max(0,Math.min(100,Math.floor(100*executable/requested))):0,
   observedGrossNotionalUsd:gross,eligibleGrossNotionalUsd:covered,observedGrossLeverage:gross/(Number(full.equityE6)/1e6),
   hypotheticalAllocationUsd:policy.maxSourceWeight*policy.capitalUsd,requestedTargetNotionalUsd:requested,executableTargetNotionalUsd:executable,
   plannedTargets:plan.orders.length,marginScale:plan.marginScale,readStartedAtMs:saved.startedAtMs,readCompletedAtMs:saved.completedAtMs,
   sourceObjectSha256:digest(saved),marketObjectSha256:digest(context.provenance.markets),
   assumptions:['Unfunded empty copy account at policy.capitalUsd; allocation is policy.maxSourceWeight.','Production minimum order, drift, lot/tick and margin planner; no historical latency/fill replay.']};
 };
 return {assess,measureSourceExecution,eligibleAssets:[...context.eligibleAssets],provenance:structuredClone(context.provenance)};
}
function sqlAdapter(db:PGlite):SQL{const make=(client:Pick<PGlite,'query'>):unknown=>{const tag=async(parts:TemplateStringsArray,...values:unknown[])=>{const query=parts.reduce((s,p,i)=>s+(i?`$${i}`:'')+p,'');const params=values.map(v=>v instanceof Date?v.toISOString():v!==null&&typeof v==='object'?json(v):v);return(await client.query(query,params)).rows;};return Object.assign(tag,{begin:(fn:(tx:SQL)=>Promise<unknown>)=>db.transaction(tx=>fn(make(tx) as SQL))});};return make(db) as SQL;}
/** Real source/market cache -> actual service modules; only our cash account is simulated. */
export async function runMeasuredService(input:MeasuredContextInput&{outPath:string;configuration:FrozenConfiguration}){
 const context=prepare(input),configuration=structuredClone(input.configuration);ensure(configuration.frozenAtMs<=context.asOfMs,'freeze is later than declared replay clock');
 ensure(configuration.sources.every(s=>context.map.has(s.sourceAddress)),'not every frozen source has completed measured reads');
 ensure(Number.isFinite(configuration.policy.capitalUsd)&&Number(configuration.policy.capitalUsd)>0,'paper capital missing');
 const capitalUsd=Number(configuration.policy.capitalUsd),runAt=Math.ceil(context.asOfMs/600_000)*600;
 mkdirSync(input.outPath,{recursive:true});const directory=mkdtempSync(join(input.outPath,'measured-')),dbPath=join(directory,'postgres'),configurationPath=join(directory,'frozen-paper.json');writeFileSync(configurationPath,json(configuration));
 let db=new PGlite(dbPath),backend:ReturnType<typeof Bun.serve>|undefined,executor:ReturnType<typeof Bun.serve>|undefined;
 try{
  for(const file of ['20261006120000_mirror.sql','20261006180000_executor_order_journal.sql'])await db.exec(readFileSync(new URL('../supabase/migrations/'+file,import.meta.url),'utf8'));
  let sql=sqlAdapter(db),store=new PostgresStore(sql);const selectedReads=configuration.sources.map(s=>context.map.get(s.sourceAddress)!);
  const originalStart=Math.min(...selectedReads.map(r=>r.startedAtMs)),originalEnd=Math.max(...selectedReads.map(r=>r.completedAtMs));
  // Stamp the actual read window, never the cache-replay I/O time.
  class MeasuredSnapshotStore extends PostgresSnapshotStore{override async putIfAbsent(slot:number,text:string){const body=JSON.parse(text) as PositionsSnapshot;body.startedAt=Math.floor(originalStart/1000);body.takenAt=Math.floor(originalEnd/1000);return super.putIfAbsent(slot,json(body));}}
  let snapshots=new MeasuredSnapshotStore(sql);const source=new FileConfigurationSource(configurationPath,configuration.configurationHash);
  let service=new SnapshotService({configurations:source,eligibility:new EligibilityTracker(new PostgresEligibilityStore(sql),async()=>new Map(context.oi)),store:snapshots,nowMs:()=>context.asOfMs,maxLeadSeconds:600,hl:context.hl});
  backend=Bun.serve({hostname:'127.0.0.1',port:0,async fetch(req){const match=/^\/(snapshots|targets)\/(\d+)$/.exec(new URL(req.url).pathname);if(!match||req.method!=='GET')return new Response('not found',{status:404});try{const slot=Number(match[2]),text=await service.get(slot);if(match[1]==='snapshots')return new Response(text,{headers:{'Content-Type':'application/json'}});const snapshot=JSON.parse(text) as PositionsSnapshot;return Response.json({runId:`mirror-${slot}`,runAt:slot,snapshotHash:keccakUtf8(text),configurationHash:configuration.configurationHash,account:configuration.account,exposures:targetsFromSnapshot(snapshot).map(e=>({asset:e.asset,exposureE9:e.exposureE9.toString()}))});}catch(error){return Response.json({error:(error as Error).message},{status:502});}}});
  const backendUrl=`http://127.0.0.1:${backend.port}`,exchange=createExchange({dryRun:true});
  const info:InfoFn=async<T>(request:Record<string,unknown>):Promise<T>=>{if(request.type==='portfolio'){ensure(request.user===configuration.account,'unmeasured own account request');return [['day',{accountValueHistory:[[context.asOfMs,String(capitalUsd)]]}]] as T;}if(request.type==='clearinghouseState'){ensure(request.user===configuration.account,'unmeasured own account request');return {assetPositions:[]} as T;}return context.marketInfo<T>(request);};
  const makeRunner=()=>new Runner({store,exchange,info,targets:backendTargets(backendUrl),now:()=>context.asOfMs,alert:async()=>{},config:{account:configuration.account as `0x${string}`,frozenConfigurationHash:configuration.configurationHash,maxGrossLeverage:configuration.policy.maxGrossLeverage,runTtlSeconds:300,runTimeoutMs:10_000,plan:{minOrderUsd:10,driftFraction:0.1,marginCap:0.95,slippageBps:50}}});
  let runner=makeRunner();const admin='local-measured-paper-only',makeApp=()=>createApp({runner,store,adminToken:admin,now:()=>context.asOfMs,log:()=>{},status:()=>({dryRun:true,unfundedPaper:true,equityUsd:capitalUsd})});let app=makeApp();executor=Bun.serve({hostname:'127.0.0.1',port:0,fetch:req=>app(req)});
  const executorUrl=`http://127.0.0.1:${executor.port}`,trigger=()=>fetch(executorUrl+'/admin/run',{method:'POST',headers:{authorization:'Bearer '+admin,'Content-Type':'application/json'},body:json({runAt})});
  const response=await trigger(),summary=await response.json() as {status:string};ensure(response.ok&&summary.status==='executed','measured dry run failed: '+json(summary));
  const run=(await store.recentRuns(1))[0];ensure(run?.plan?.orders.length&&run.results?.length===run.plan.orders.length&&run.results.every(r=>r.status==='dry_run'),'empty/non-dry run result');
  const snapshotText=await(await fetch(backendUrl+`/snapshots/${runAt}`)).text(),snapshot=JSON.parse(snapshotText) as PositionsSnapshot,evidence=run.evidence as {snapshotHash:string;configurationHash:string;exposures:unknown};
  ensure(evidence.snapshotHash===keccakUtf8(snapshotText)&&evidence.configurationHash===configuration.configurationHash,'snapshot evidence mismatch');ensure(json(targetsFromSnapshot(snapshot))===json(evidence.exposures),'target evidence mismatch');
  const expectedSources=configuration.sources.map(s=>s.sourceAddress).sort();ensure(json(snapshot.sources.map(s=>s.address))===json(expectedSources),'incomplete frozen source snapshot');
  const paperMarkets=new Map<string,{markPx:number;maxLeverage:number;feeBps:number;fundingRate:number}>();
  for(const [dex,pair] of [['',context.core],['xyz',context.xyz]] as const)pair[0].universe.forEach((m,i)=>{const ctx=pair[1][i],mark=Number(ctx.markPx);if(!(mark>0))return;if(context.eligibleAssets.includes(m.name)||m.name==='BTC')ensure(ctx.funding!==undefined&&Number.isFinite(Number(ctx.funding)),'measured funding missing');paperMarkets.set(m.name,{markPx:mark,maxLeverage:m.maxLeverage,feeBps:dex?9:4.5,fundingRate:Number(ctx.funding??'0')});});ensure(paperMarkets.has('BTC'),'measured BTC market missing');
  const specs:BookSpec[]=[{id:'review-paper',label:'Reviewed sources · unfunded paper',kind:'copy',startingEquityUsd:capitalUsd},{id:'review-twin',label:'Reviewed sources · unfunded $10k twin',kind:'copy',startingEquityUsd:10_000},{id:'balanced-paper',label:'Half exposure · unfunded paper',kind:'copy',startingEquityUsd:capitalUsd,multiplier:0.5},{id:'btc-paper',label:'BTC benchmark · unfunded paper',kind:'btc',startingEquityUsd:capitalUsd}];
  const makePaper=()=>new PaperService({store:new PostgresPaperStore(sql),specs,cfg:{minOrderUsd:10,driftFraction:0.1,marginCap:0.95,slippageBps:5},markets:async()=>new Map(paperMarkets)});let paper=makePaper();ensure((await paper.step(runAt,snapshotText)).length===4,'paper books missing');
  const calls=exchange.recorded().length;ensure((await(await trigger()).json() as {status:string}).status==='duplicate','duplicate run was not held');
  await db.close();db=new PGlite(dbPath);sql=sqlAdapter(db);store=new PostgresStore(sql);snapshots=new MeasuredSnapshotStore(sql);service=new SnapshotService({configurations:source,eligibility:new EligibilityTracker(new PostgresEligibilityStore(sql),async()=>new Map(context.oi)),store:snapshots,nowMs:()=>context.asOfMs,maxLeadSeconds:600,hl:context.hl});runner=makeRunner();app=makeApp();paper=makePaper();
  ensure((await(await trigger()).json() as {status:string}).status==='duplicate'&&exchange.recorded().length===calls,'restart duplicated exchange actions');ensure(await snapshots.get(runAt)===snapshotText,'restart changed snapshot');
  const paperView=await paper.view();ensure(paperView.lastRunAt===runAt&&paperView.books.length===4,'restart lost paper state');const dashboard=await(await fetch(executorUrl+'/runs?limit=1')).json() as RunRecord[];ensure(digest(dashboard[0].evidence)===digest(run.evidence),'dashboard evidence mismatch');
  const result={schemaVersion:'measured-service-proof.v1',mode:'measured-source-and-market-cache-unfunded-paper',sourceKind:input.sourceKind,dataKind:input.sourceKind==='REAL_PUBLIC_API'?'measured-public-api-responses':'synthetic-fixture-responses',economicAuthority:false,configurationHash:configuration.configurationHash,runId:run.runId,runAt,asOfMs:context.asOfMs,snapshotHash:evidence.snapshotHash,sourceCount:expectedSources.length,sourceReadHashes:context.provenance.sourceReads.filter(r=>expectedSources.includes(r.address)),marketReadHashes:context.provenance.markets,measurementSha256:digest(context.provenance),paperAccount:{account:configuration.account,equityUsd:capitalUsd,positions:'empty simulated starting book',funded:false},plan:run.plan,results:run.results,sourcePositions:snapshot.sources,eligibleAssets:context.eligibleAssets,checks:{nonemptyDryRun:true,snapshotHashRecomputed:true,targetExposuresRecomputed:true,allFrozenSourcesMeasured:true,duplicateNoOp:true,restartDuplicateNoOp:true,restartSnapshotUnchanged:true,restartPaperPersisted:true,dashboardEvidenceMatches:true},assumptions:{ownCapital:'simulated policy.capitalUsd, never claimed to be live account equity',feesBps:{core:4.5,hip3:9},paperSlippageBps:5,executorLimitSlippageBps:50},boundaries:['Measured source portfolio/positions and market metadata; no fabricated source or market/OOS data.','Exact measured reads are replayed at the declared asOf clock; this is not a newly fetched execution snapshot.','Own account cash/positions, paper fees and execution outcomes are simulated; no external orders or provider calls.','Actual service modules, HTTP and production store queries on local PGlite; no hosted, pooler or advisory-lock proof.'],upstreamRequestsPerformed:0,liveOrdersSubmitted:0};
  for(const [file,body] of Object.entries({'proof.json':result,'provenance.json':context.provenance,'snapshot.json':snapshot,'dashboard-runs.json':dashboard,'paper.json':paperView}))writeFileSync(join(directory,file),json(body)+'\n');return result;
 }finally{backend?.stop(true);executor?.stop(true);await db.close();}
}

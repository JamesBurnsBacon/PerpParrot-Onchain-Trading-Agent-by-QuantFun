/** Offline state-machine rehearsal. Logical time is accelerated; this is not a live soak test. */
import {mkdirSync,readFileSync,writeFileSync,readdirSync} from 'node:fs';
import {join,resolve,relative} from 'node:path';
import {createHash} from 'node:crypto';
import {parseArgs} from 'node:util';
import {LoopStore,bucketAt,INTERVAL_MS,type Account,type Selection} from '../packages/backend/src/ingest/loop/store.ts';
import {LoopService,type Collector} from '../packages/backend/src/ingest/loop/service.ts';
import {BudgetClient} from '../packages/backend/src/ingest/loop/client.ts';
import {priority} from '../packages/backend/src/ingest/loop/rank.ts';
import {availableAccounts,backgroundRefresh,BACKGROUND_POLICY} from '../packages/backend/src/ingest/loop/background.ts';
import {loopHandler,type Latest} from '../packages/backend/src/ingest/loop/http.ts';
import {parsePortfolio} from '../packages/backend/src/score/parse.ts';
import {SOURCES} from '../packages/backend/src/ingest/client.ts';
import type {ScoreInput} from '../packages/backend/src/score/types.ts';

const ROOT=resolve(import.meta.dir,'..'),DAY=86_400_000;
const hash=(s:string|Uint8Array)=>createHash('sha256').update(s).digest('hex');
const write=(path:string,value:unknown)=>writeFileSync(path,JSON.stringify(value,null,2)+'\n');
const read=<T>(path:string):T=>JSON.parse(readFileSync(path,'utf8'));
type Clock={now:number};
type Check={id:string;passed:true;details:unknown};
type Spec={logicalMs:number;runId:string;badAddress:string;database:string};

function portfolio(now:number){
  const av:[number,string][]=[],pnl:[number,string][]=[];let profit=0;
  for(let i=0;i<=90;i++){profit+=i%4===0?-50:100;const at=now-(90-i)*DAY;av.push([at,String(100000+profit)]);pnl.push([at,String(profit)]);}
  return [['month',{accountValueHistory:av.slice(-31),pnlHistory:pnl.slice(-31)}],
    ['allTime',{accountValueHistory:av,pnlHistory:pnl}]];
}
function seed(store:LoopStore,clock:Clock){
  const raw=JSON.stringify(portfolio(clock.now)),rawHash=store.blob(raw),windows=parsePortfolio(JSON.parse(raw));
  const accounts:Account[]=Array.from({length:128},(_,i)=>{
    const address=`0x${(i+1).toString(16).padStart(40,'0')}` as `0x${string}`;
    const fetchedAt=new Date(i===0||i>=106?clock.now-25*3_600_000:clock.now).toISOString();
    const input:ScoreInput={address,kind:'trader',accountValue:106700,closed:false,...structuredClone(windows),history:null,tradeCount:100};
    return {candidate:{address,accountValueOrTvlUsd:'106700',valueSource:'leaderboard-account-value',sources:['leaderboard'],
      name:null,knownHypercoreVault:false,leaderAddress:null},input,fetchedAt,rawHash,
      classification:{kind:'trader',evidence:'no-hyperevm-code'},classificationAt:fetchedAt,fillsHash:null,fillsCheckedAt:null,basis:'verified-input'};
  });
  store.seed(accounts,{kind:'SYNTHETIC_FIXTURE',economicAuthority:false});
  const selected=priority(accounts,clock.now);if(selected.length!==100)throw new Error('FIXTURE_NOT_STRICT_TOP100');
  store.setState('selection',{selected});store.setState('bootstrapComplete',{at:clock.now});
  return {accounts,selected};
}

function mockedCollector(store:LoopStore,clock:Clock,badAddress:string,
  block?:{original:Set<string>;entered:()=>void}):Collector&{calls:{total:number;paused:boolean}}{
  const calls={total:0,paused:false};
  let lastHeartbeat=clock.now;
  const client=new BudgetClient(store,async(_url,init)=>{
    const request=JSON.parse(String(init?.body));
    if(request.type!=='portfolio')throw new Error('UNEXPECTED_MOCK_REQUEST');
    if(request.user===badAddress)return new Response('fixture account unavailable',{status:404});
    if(block&&!block.original.has(request.user)&&!calls.paused){
      calls.paused=true;block.entered();
      await new Promise((_resolve,reject)=>{const signal=init?.signal;if(signal?.aborted)reject(signal.reason);
        else signal?.addEventListener('abort',()=>reject(signal.reason),{once:true});});
    }
    clock.now+=1;return Response.json(portfolio(clock.now));
  },()=>clock.now,async ms=>{
    clock.now+=ms;
    // Virtual quota waits advance milliseconds instantly. Explicitly tick the
    // same lease renewal that production's real 15-second timer would execute.
    if(clock.now-lastHeartbeat>=15_000){
      const lease=store.db.query<{owner:string},[]>('select owner from lease where id=1').get();
      if(lease)store.renew(lease.owner,clock.now);lastHeartbeat=clock.now;
    }
  });
  return {client,calls,async collect(previous,signal){
    calls.total++;
    const raw=await client.request(SOURCES.info,{type:'portfolio',user:previous.input.address},signal);
    const account=structuredClone(previous);account.rawHash=store.blob(raw);account.fetchedAt=new Date(clock.now).toISOString();
    Object.assign(account.input,parsePortfolio(JSON.parse(raw)));
    account.input.accountValue=account.input.month!.accountValueHistory.at(-1)![1];
    return {account,historyWarnings:[]};
  }};
}

async function resumeChild(directory:string){
  const spec=read<Spec>(join(directory,'resume-spec.json')),clock={now:spec.logicalMs},store=new LoopStore(spec.database);
  try{
    const collector=mockedCollector(store,clock,spec.badAddress),service=new LoopService(store,collector,undefined,()=>clock.now);
    await service.execute(store.run(spec.runId)!);
    write(join(directory,'resume-result.json'),{pid:process.pid,logicalMs:clock.now,collectionCalls:collector.calls.total,
      requestCount:collector.client!.requests,latest:store.state('latest'),run:store.run(spec.runId)});
    await service.stop();
  }finally{store.close();}
}

function codeIdentity(){
  const paths=[import.meta.path,...readdirSync(join(ROOT,'packages/backend/src/ingest/loop')).filter(p=>p.endsWith('.ts')).map(p=>join(ROOT,'packages/backend/src/ingest/loop',p)),
    ...readdirSync(join(ROOT,'packages/backend/src/score')).filter(p=>p.endsWith('.ts')).map(p=>join(ROOT,'packages/backend/src/score',p))].sort();
  const files=paths.map(path=>({path:relative(ROOT,path),sha256:hash(readFileSync(path))}));
  return {sha256:hash(JSON.stringify(files)),files};
}

export async function runAcceleratedIngest(out:string){
  mkdirSync(out,{recursive:true});const startedAt=Date.now(),code=codeIdentity();
  const directory=join(out,`run-${startedAt}`);mkdirSync(directory,{recursive:true});
  const database=join(directory,'loop.sqlite'),clock={now:bucketAt(Date.UTC(2026,9,7))+180_000};
  const checks:Check[]=[],check=(id:string,condition:unknown,details:unknown={})=>{
    if(!condition)throw new Error('ACCELERATED_INGEST_CHECK_FAILED:'+id);checks.push({id,passed:true,details});};
  let store=new LoopStore(database),open=true;
  try{
    const {accounts,selected}=seed(store,clock),bad=selected[10]!.address,stale=accounts[0]!.input.address;
    check('expired-unselected-candidate-initially-excluded',!selected.some(s=>s.address===stale),{ageHours:25});
    const owner=store.claim(clock.now)!;store.accountAttempt(bad,owner,clock.now,{error:'fixture prior failure'});store.release(owner);
    let entered!:()=>void;const paused=new Promise<void>(resolve=>{entered=resolve;});
    const initial=mockedCollector(store,clock,bad,{original:new Set(selected.map(s=>s.address)),entered});
    const first=new LoopService(store,initial,undefined,()=>clock.now),run=first.trigger();
    const work=first.start(run).catch(error=>String(error));
    await paused;await first.stop();await work;
    const stopped=store.run(run.id)!;
    check('partial-fault-does-not-publish',store.state('latest')===null&&store.records(run.id).size===10,{durableRecords:store.records(run.id).size});
    check('replacement-committed-before-next-request',stopped.substitutions?.length===1&&stopped.effectiveSelection?.[10]!.address!==bad,
      {substitutions:stopped.substitutions?.length});
    check('bad-account-quarantined',store.health(bad).consecutiveFailures===2&&store.health(bad).quarantinedUntil>clock.now,
      {consecutiveFailures:store.health(bad).consecutiveFailures,cooldownMs:store.health(bad).quarantinedUntil-clock.now});
    write(join(directory,'resume-spec.json'),{logicalMs:clock.now,runId:run.id,badAddress:bad,database} satisfies Spec);
    store.close();open=false;
    const child=Bun.spawn([process.execPath,'--no-env-file',import.meta.path,'--resume',directory],{stdout:'pipe',stderr:'pipe'});
    const [exit,stderr]=await Promise.all([child.exited,new Response(child.stderr).text()]);
    if(exit!==0)throw new Error('RESUME_CHILD_FAILED:'+stderr.slice(0,2000));
    const resumed=read<{pid:number;logicalMs:number;collectionCalls:number;requestCount:number;latest:Latest}>(join(directory,'resume-result.json'));
    clock.now=resumed.logicalMs;store=new LoopStore(database);open=true;
    check('separate-process-restart-resumes-only-missing-records',resumed.pid!==process.pid&&resumed.collectionCalls===90,
      {originalPid:process.pid,resumePid:resumed.pid,resumedCollections:resumed.collectionCalls});
    const firstPublication=store.state<Latest>('latest')!,artifact=JSON.parse(store.raw(firstPublication.artifactHash));
    check('published-effective-top100-strict-and-unique',artifact.inputs.length===100&&new Set(artifact.inputs.map((i:ScoreInput)=>i.address)).size===100
      &&artifact.strict.candidates.every((c:{eligible:boolean})=>c.eligible)&&!artifact.inputs.some((i:ScoreInput)=>i.address===bad),
      {count:artifact.count,strictEligible:artifact.strict.candidates.filter((c:{eligible:boolean})=>c.eligible).length});
    check('original-selection-and-substitution-history-preserved',JSON.stringify(artifact.originalSelection)===JSON.stringify(selected)
      &&artifact.substitutions.length===1&&/^[a-f0-9]{64}$/.test(artifact.substitutions[0].rankingSha256));
    write(join(directory,'bucket-1.json'),artifact);
    const collector=mockedCollector(store,clock,bad),service=new LoopService(store,collector,undefined,()=>clock.now);
    const before=collector.calls.total;await service.execute(store.run(run.id)!);
    check('duplicate-replay-makes-zero-upstream-calls',collector.calls.total===before,{newCalls:collector.calls.total-before});
    clock.now=bucketAt(clock.now)+INTERVAL_MS+180_000;
    await service.start(service.trigger());const secondPublication=store.state<Latest>('latest')!;
    check('second-ten-minute-bucket-publishes',secondPublication.bucket===firstPublication.bucket+INTERVAL_MS&&secondPublication.count===100,
      {firstBucket:firstPublication.bucket,secondBucket:secondPublication.bucket,logicalDifferenceMs:secondPublication.bucket-firstPublication.bucket});
    write(join(directory,'bucket-2.json'),JSON.parse(store.raw(secondPublication.artifactHash)));
    const handler=loopHandler(store,service,()=>clock.now);
    const fixed=await handler(new Request(`http://localhost/ingest/runs/${run.id}/publication`));
    check('historical-bucket-http-remains-immutable',fixed.status===200&&(await fixed.json() as Latest).artifactHash===firstPublication.artifactHash);
    check('quarantined-account-excluded-from-next-ranking',!availableAccounts(store,store.accounts(),clock.now).some(a=>a.input.address===bad));
    const callsBefore=collector.calls.total;
    const rotation=await backgroundRefresh(store,collector,()=>clock.now,undefined,{...BACKGROUND_POLICY,maxAccounts:1});
    const newSelection=store.state<{selected:Selection[]}>('selection')!.selected;
    check('background-oldest-first-candidate-refreshed',rotation.refreshed===1&&store.health(stale).lastSuccessAt!==null,
      {refreshed:rotation.refreshed,newCollections:collector.calls.total-callsBefore});
    check('expired-candidate-can-reenter-top100',newSelection.some(s=>s.address===stale));
    check('background-and-foreground-share-durable-budget',collector.client!.requests===101
      &&store.db.query<{n:number},[]>('select count(*) as n from budget where scope=\'info\'').get()!.n>0,
      {resumedServiceRequests:collector.client!.requests});
    clock.now+=3_660_000;
    check('cooldown-expiry-alone-does-not-promote-bad-cache',!availableAccounts(store,store.accounts(),clock.now).some(a=>a.input.address===bad));
    check('stale-latest-http-fails-closed',(await handler(new Request('http://localhost/ingest/latest'))).status===503);
    check('committed-old-artifact-remains-readable',(await handler(new Request(`http://localhost/ingest/artifacts/${firstPublication.artifactHash}`))).status===200);
    await service.stop();store.close();open=false;store=new LoopStore(database);open=true;
    check('background-progress-survives-second-reopen',store.state<{refreshed:number}>('backgroundTotals')?.refreshed===1
      &&store.state<Latest>('latest')!.artifactHash===secondPublication.artifactHash);
    check('sqlite-integrity-check',store.db.query<{quick_check:string},[]>('PRAGMA quick_check').get()!.quick_check==='ok');
    const after=codeIdentity();check('implementation-stable-during-rehearsal',after.sha256===code.sha256);
    const report={schema:'accelerated-ingest-rehearsal.v1',status:'VERIFIED',recordedAt:new Date().toISOString(),
      sourceKind:'SYNTHETIC_FIXTURE',clock:'ACCELERATED_LOGICAL_TIME_WITH_EXPLICIT_15S_LEASE_TICKS',economicAuthority:false,
      networkRequestsToExternalHosts:0,actualElapsedMs:Date.now()-startedAt,
      scope:'Production loop, strict Score, background rotation, HTTP handlers, request-budget client and SQLite; synthetic portfolio/classification/order-count fixture; mocked official-info responses. Not live API reliability or 24-hour uptime evidence.',
      modules:['LoopService','LoopStore','scoreCandidates','rankAsync','BudgetClient','backgroundRefresh','loopHandler'],
      code,checks,artifactHashes:{first:firstPublication.artifactHash,second:secondPublication.artifactHash},
      reportDirectory:relative(ROOT,directory),databaseValidation:'quick_check=ok',processRestart:true};
    write(join(directory,'report.json'),report);write(join(out,'report.json'),report);
    write(join(out,'report.sha256'),{sha256:hash(readFileSync(join(out,'report.json')))});
    return report;
  }finally{if(open)store.close();}
}

if(import.meta.main){
  const {values}=parseArgs({options:{out:{type:'string',default:'night-shift-integration/out/accelerated-ingest'},resume:{type:'string'}}});
  if(values.resume)await resumeChild(resolve(values.resume));
  else{const report=await runAcceleratedIngest(resolve(values.out!));console.log(JSON.stringify({status:report.status,checks:report.checks.length,
    actualElapsedMs:report.actualElapsedMs,externalRequests:0,report:join(values.out!,'report.json')}));}
}

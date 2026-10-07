import {afterAll,beforeAll,beforeEach,describe,expect,test} from 'bun:test';
import {PGlite} from '@electric-sql/pglite';
import {SQL} from 'bun';
import {PgIngestStore,bunDatabase,type Database,type Account} from '../src/ingest/store';
import {BudgetClient,SOURCES,DISPATCH_LEASE_MS,type Transport} from '../src/ingest/client';
import {IngestPipeline,ingestHandler,jobBucket} from '../src/ingest/pipeline';
import {discover} from '../src/ingest/discovery';
import {loadInputs,prepareHistory,toScoreInput} from '../src/ingest/loader';
import {checkFunnelArtifact} from '../../shared/dashboard';
import {initialOrderStats,importScreeningRow} from '../src/ingest/import-screening';
const migration=await Bun.file(new URL('../../../supabase/migrations/20261007110000_ingest_pipeline.sql',import.meta.url)).text();
const DAY=86_400_000,now=Date.now(),address=(n:number)=>`0x${n.toString(16).padStart(40,'0')}` as `0x${string}`;
const candidate=(n:number)=>({address:address(n),accountValueOrTvlUsd:'12000',valueSource:'leaderboard-account-value' as const,
  sources:['leaderboard' as const],name:null,knownHypercoreVault:false,leaderAddress:null});
const portfolio=(end=now,value=12000)=>['month','allTime'].map((w)=>[w,{
  accountValueHistory:Array.from({length:32},(_,i)=>[end-(31-i)*DAY,String(value+i*20)]),
  pnlHistory:Array.from({length:32},(_,i)=>[end-(31-i)*DAY,String(i*20)]),vlm:'100000'}]);
const fill=(n:number,time=now-1000+n)=>({coin:'BTC',oid:n,tid:n,time,px:'100',sz:'1',startPosition:'0',side:'B',crossed:false});
const budget={reserve:async()=>({id:'reservation',waitMs:0}),refund:async()=>{}};
const transport=(fn:(url:string,body:any)=>unknown)=> (async(url,init)=>Response.json(fn(String(url),init?.body?JSON.parse(String(init.body)):null))) as Transport;
function adapter(pg:Pick<PGlite,'query'|'transaction'>):Database{
  return {query:async(text,values=[])=> (await pg.query(text,values)).rows as any,
    transaction:fn=>pg.transaction(tx=>fn(adapter(tx as any)))};
}
let pg:PGlite,db:Database,store:PgIngestStore;
beforeAll(async()=>{pg=new PGlite();db=adapter(pg);store=new PgIngestStore(db);
  await pg.exec("create table public.dashboard_artifacts(name text primary key,body jsonb,updated_at timestamptz default now())");
  await pg.exec(migration);},30_000);
afterAll(async()=>{await pg.close();});
beforeEach(async()=>{await pg.exec('truncate public.ingest_agent_jobs,public.ingest_accounts,public.ingest_portfolios,public.ingest_fill_stats,public.ingest_runs,public.score_runs,public.dashboard_artifacts; update public.ingest_budget set reservations=\'[]\',blocked_until=\'{}\'');});
async function seed(n=2){const claim=(await store.claimJob('discover',jobBucket('discover',now)))!;
  await store.saveDiscovery(claim,Array.from({length:n},(_,i)=>candidate(i+1)),{accounts:n});}
async function save(n:number,end=now){const token='test';await db.query("update public.ingest_accounts set claim_token=$2,claim_until=now()+interval '1 minute' where address=$1",[address(n),token]);
  const row=(await store.accounts(address(n)))[0],raw=portfolio(end),fetchedAt=new Date(end).toISOString();
  const h=prepareHistory(row,raw,fetchedAt);
  await store.saveAccount(address(n),token,{raw,fetchedAt,...h,classification:{kind:'trader',evidence:'no-hyperevm-code'},
    stats:{asOf:fetchedAt,startTime:end-30*DAY,endTime:end,orderCount:12,tradeCount:12,fills:12,pages:1,complete:true,makerShare:0.5,medianHoldHours:null,flags:[]}});}

test('discovery keeps exact cutoff, positive two-window PnL and excludes child vaults',()=>{
  const trader=(n:number,equity='10000',pnl='1')=>({ethAddress:address(n),accountValue:equity,windowPerformances:[['month',{pnl}],['allTime',{pnl}]]});
  const vault=(n:number,type='normal')=>({pnls:[['month',['1','2']],['allTime',['0','2']]],
    summary:{vaultAddress:address(n),tvl:'10000',name:'v',leader:address(99),isClosed:false,relationship:{type}}});
  expect(discover({leaderboardRows:[trader(1),trader(2,'9999.999999'),trader(3,'10000','0'),trader(4)]},[vault(4,'child'),vault(5)]).candidates.map(c=>c.address)).toEqual([address(1),address(5)]);
  expect(()=>discover({leaderboardRows:[]},[])).toThrow('Empty');
});
test('cron bucket claims survive restart and allow failed retries, never completed replays',async()=>{
  const first=await store.claimJob('refresh',1);expect(first).not.toBeNull();
  expect(await new PgIngestStore(db).claimJob('refresh',1)).toBeNull();
  await store.finish(first!,'failed',{});const retry=await store.claimJob('refresh',1);expect(retry).not.toBeNull();
  await store.finish(retry!,'complete',{});expect(await store.claimJob('refresh',1)).toBeNull();
  expect(()=>store.finish(first!,'complete',{})).toThrow('Cron claim lost');
});
test('stale first, claimed account skipped, expiry recovers and one attempt per invocation',async()=>{
  await seed();await save(1,now-3600_000);
  const before=new Date(now+1000).toISOString();const a=await store.claimAccount('a',before),b=await store.claimAccount('b',before);
  expect(a?.address).toBe(address(2));expect(b?.address).toBe(address(1));expect(await store.claimAccount('c',before)).toBeNull();
  await db.query("update public.ingest_accounts set claim_until=now()-interval '1 second',attempted_at=now()-interval '10 seconds' where address=$1",[address(2)]);
  expect((await store.claimAccount('c',before))?.address).toBe(address(2));
  await store.failAccount(address(2),'c','timeout');expect(await store.claimAccount('d',before)).toBeNull();
});
test('daily rediscovery can add/remove accounts without deleting their history',async()=>{
  await seed();await save(1);await Bun.sleep(2);
  const c=(await store.claimJob('discover',jobBucket('discover',now)+DAY))!;await store.saveDiscovery(c,[candidate(2),candidate(3)],{});
  expect((await store.accounts()).map(a=>a.address)).toEqual([address(2),address(3)]);
  expect((await store.accounts(address(1)))[0].portfolio).not.toBeNull();
});
test('priority preempts a waiting background claim; the old writer cannot commit or clear the new claim',async()=>{
  await seed(1);const background=(await store.claimJob('refresh',1))!,priority=(await store.claimJob('priority',1))!;
  expect((await store.claimAccount(background.token,background.startedAt))?.address).toBe(address(1));
  expect((await store.claimAccount(priority.token,priority.startedAt,address(1)))?.address).toBe(address(1));
  await expect(store.saveClassification(address(1),background.token,{kind:'trader',evidence:'no-hyperevm-code'})).rejects.toThrow('Account claim lost');
  await store.failAccount(address(1),background.token,'superseded');
  expect((await db.query('select claim_token from public.ingest_accounts'))[0].claim_token).toBe(priority.token);
});
test('late older discovery never overwrites newer registry',async()=>{
  const old=(await store.claimJob('discover',1))!,newer=(await store.claimJob('discover',2))!;
  await store.saveDiscovery(newer,[candidate(2)],{});await store.saveDiscovery(old,[candidate(1)],{});
  expect((await store.accounts()).map(a=>a.address)).toEqual([address(2)]);
});
test('shared minute budget never grants more than 1200, refunds only unused capacity',async()=>{
  const stores=[store,new PgIngestStore(db)];const granted=await Promise.all(Array.from({length:61},(_,i)=>stores[i%2].reserve('info',20)));
  expect(granted.filter(r=>r.id)).toHaveLength(60);expect(granted[60].waitMs).toBeGreaterThan(0);
  await store.refund(granted[0].id!,10);expect((await store.reserve('info',10)).id).toBeDefined();
  expect((await store.reserve('rpc',1)).id).toBeDefined();
  await db.query("update public.ingest_budget set reservations='[]'");expect((await store.reserve('info',600)).id).toBeDefined();
});
test('minute boundary retains weight until the dispatch lease also expires',async()=>{
  await db.query(`update public.ingest_budget set reservations=jsonb_build_array(jsonb_build_object(
    'id','delayed-send','scope','info','weight',1200,'time',extract(epoch from clock_timestamp())*1000-60500))`);
  expect((await store.reserve('info',20)).id).toBeUndefined();
  await db.query(`update public.ingest_budget set reservations=jsonb_build_array(jsonb_build_object(
    'id','expired','scope','info','weight',1200,'time',extract(epoch from clock_timestamp())*1000-61001))`);
  expect((await store.reserve('info',20)).id).toBeDefined();
});
test('a delayed SQL grant cannot authorize an HTTP dispatch after its lease',async()=>{
  let ms=0,grants=0,calls=0;
  const delayed={reserve:async()=>{grants++;ms+=grants===1?DISPATCH_LEASE_MS:1;return {id:String(grants),waitMs:0};},refund:async()=>{}};
  const client=new BudgetClient(delayed,new AbortController().signal,async()=>{
    calls++;expect(grants).toBe(2);return Response.json([]);
  },async()=>{},()=>ms);
  await client.request(SOURCES.info,{type:'portfolio',user:address(1)});
  expect(grants).toBe(2);expect(calls).toBe(1);expect(client.requests).toBe(1);expect(client.infoWeight).toBe(20);
});
test('429 retries honor Retry-After and reserve each attempt',async()=>{
  let calls=0,reservations=0,slept=0;
  const client=new BudgetClient({reserve:async()=>{reservations++;return {id:'x',waitMs:0};},refund:async()=>{}},new AbortController().signal,
    (async()=>++calls===1?new Response('',{status:429,headers:{'Retry-After':'13'}}):Response.json([])) as Transport,async ms=>{slept+=ms;});
  await client.request(SOURCES.info,{type:'portfolio',user:address(1)});
  expect(slept).toBe(13000);expect(reservations).toBe(2);expect(client.rateLimited).toBe(1);
});
test('deadline interrupts a Retry-After wait without another API attempt',async()=>{
  const ac=new AbortController();let calls=0;
  const client=new BudgetClient(budget,ac.signal,(async()=>{calls++;return new Response('',{status:429,headers:{'Retry-After':'60'}});}) as Transport,async()=>ac.abort());
  await expect(client.request(SOURCES.info,{})).rejects.toThrow();expect(calls).toBe(1);
});
test('history conflicts discard older accumulated points; future data fails',async()=>{
  await seed(1);await save(1);const row=(await store.accounts())[0];
  const altered={...row,history:[...row.history,{...row.history[0],accountValue:99999,fetchedAt:new Date(now-1000).toISOString(),runId:'old'}]};
  expect(prepareHistory(altered,row.portfolio,new Date(now).toISOString()).flags).toContain('older-history-conflict');
  expect(()=>prepareHistory(row,portfolio(now+1),new Date(now).toISOString())).toThrow('Future');
});
test('missing and future fill evidence stays unknown; ERC4626 closed status is not invented',async()=>{
  await seed(1);await save(1);const row=(await store.accounts())[0];
  expect(toScoreInput({...row,stats:null},now).tradeCount).toBeNull();
  expect(toScoreInput({...row,stats:{...row.stats!,endTime:now+1}},now).makerShare).toBeNull();
  expect(toScoreInput({...row,classification:{kind:'erc4626-vault',evidence:'erc4626-probes'}},now).closed).toBeNull();
});
test('initial order proof survives portfolio refresh without pretending old maker evidence is current',async()=>{
  await seed(1);await save(1);const row=(await store.accounts())[0],end=now-15*DAY;
  const stats=initialOrderStats(Array.from({length:12},(_,i)=>fill(i,end-100+i)),end,new Date(end).toISOString(),'a'.repeat(64));
  const input=toScoreInput({...row,stats},now);
  expect(input.tradeCount).toBe(12);expect(input.makerShare).toBeNull();expect(input.medianHoldHours).toBeNull();
  const copy={candidate:row.candidate,classification:row.classification,portfolio:portfolio(end),fetchedAt:new Date(end).toISOString(),stats};
  await db.query('delete from public.ingest_fill_stats');
  await importScreeningRow(db,copy);await importScreeningRow(db,copy);
  const after=(await store.accounts())[0];expect(new Date(after.fetched_at!).getTime()).toBe(now);
  expect(after.stats?.asOf).toBe(stats.asOf);expect((await store.accounts()).length).toBe(1);
});
test('below 95% fresh waits; at 95% real Score and validated dashboard funnel publish atomically',async()=>{
  await seed(20);for(let n=1;n<=18;n++)await save(n);
  const pipeline=new IngestPipeline(store,()=>Date.now(),signal=>new BudgetClient(budget,signal,
    transport((_u,b)=>b.type==='portfolio'?portfolio(Date.now()):[]))),signal=new AbortController().signal;
  expect((await pipeline.run('priority',signal)).status).toBe('waiting');
  expect(await db.query('select * from public.score_runs')).toHaveLength(0);
  await save(19);const result=await pipeline.run('priority',signal);expect(result.status).toBe('complete');
  const [run]=await db.query('select * from public.score_runs');expect(run.coverage.fresh).toBe(19);expect(run.result.finalists.length).toBeGreaterThan(0);
  const [artifact]=await db.query("select body from public.dashboard_artifacts where name='funnel'");
  expect(checkFunnelArtifact(artifact.body)).toEqual([]);expect(artifact.body.finalists.every((f:any)=>f.picked===false)).toBe(true);
  expect((await pipeline.run('select',signal)).status).toBe('already-claimed');
});
test('discovery -> portfolio refresh with initial evidence -> Score -> dashboard, without repeat fills',async()=>{
  let tick=Date.now(),calls:string[]=[];
  const fetcher=transport((u,b)=>{calls.push(b?.type??b?.method??u);
    if(u===SOURCES.leaderboard)return {leaderboardRows:[{ethAddress:address(1),accountValue:'12000',windowPerformances:[['month',{pnl:'1'}],['allTime',{pnl:'1'}]]}]};
    if(u===SOURCES.vaults)return [];
    if(b?.method==='eth_chainId')return {result:'0x3e7'};if(b?.method==='eth_blockNumber')return {result:'0x123'};if(b?.method==='eth_getCode')return {result:'0x'};
    if(b?.type==='portfolio')return portfolio(Date.now());throw new Error('unexpected request');});
  const pipeline=new IngestPipeline(store,()=>Date.now(),signal=>new BudgetClient(budget,signal,fetcher));const signal=new AbortController().signal;
  expect((await pipeline.run('discover',signal)).status).toBe('complete');
  await save(1);await db.query("update public.ingest_accounts set refreshed_at=null");tick=Date.now()+10;
  const refreshed:any=await pipeline.run('refresh',signal);expect(refreshed.updated).toBe(1);expect(refreshed.failed).toBe(0);
  tick=Date.now()+1;expect((await pipeline.run('priority',signal)).status).toBe('complete');
  expect(calls.filter(c=>c==='portfolio')).toHaveLength(2);expect(calls).not.toContain('userFillsByTime');
  expect((await db.query('select result from public.score_runs'))[0].result.finalists).toEqual([address(1)]);
});
test('background refresh never requests fills, even when initial trade evidence is missing',async()=>{
  await seed(6);await db.query(`update public.ingest_accounts set classification='{"kind":"trader","evidence":"no-hyperevm-code"}'`);
  let portfolios=0;
  const fetcher:Transport=async(_url,init)=>{
    const body=JSON.parse(String(init?.body));
    if(body.type==='portfolio'){portfolios++;return Response.json(portfolio(Date.now()));}
    throw new Error('Unexpected request: '+body.type);
  };
  const pipeline=new IngestPipeline(store,Date.now,signal=>new BudgetClient(budget,signal,fetcher));
  const result=await pipeline.run('refresh',new AbortController().signal);
  expect(result.updated).toBe(6);expect(result.failed).toBe(0);
  const rows=await store.accounts();expect(loadInputs(rows,Date.now()).coverage.fresh).toBe(6);
  expect(rows.every(row=>row.stats===null)).toBe(true);
});
test('background refresh resolves missing classification before saving without fetching fills',async()=>{
  await seed(1);const calls:string[]=[];
  const fetcher=transport((_url,body)=>{
    calls.push(body.method??body.type);
    if(body.method==='eth_chainId')return {result:'0x3e7'};
    if(body.method==='eth_blockNumber')return {result:'0x123'};
    if(body.method==='eth_getCode')return {result:'0x'};
    if(body.type==='portfolio')return portfolio(Date.now());
    throw new Error('Unexpected request');
  });
  const pipeline=new IngestPipeline(store,Date.now,signal=>new BudgetClient(budget,signal,fetcher));
  const result=await pipeline.run('refresh',new AbortController().signal);
  expect(result.updated).toBe(1);expect(result.failed).toBe(0);
  expect(calls).toEqual(['eth_chainId','eth_blockNumber','eth_getCode','portfolio']);
  const [row]=await store.accounts();expect(row.classification?.kind).toBe('trader');expect(row.stats).toBeNull();
});
test('authentication rejects missing configuration and wrong secret before work',async()=>{
  const req=(secret?:string)=>new Request('https://example.test/cron/refresh',{headers:secret?{authorization:`Bearer ${secret}`}:{}});
  expect((await ingestHandler(undefined,undefined)(req(),'/cron/refresh'))?.status).toBe(503);
  const handler=ingestHandler(new IngestPipeline(store),'secret');expect((await handler(req('wrong'),'/cron/refresh'))?.status).toBe(401);
  expect(await db.query('select * from public.ingest_runs')).toHaveLength(0);
});
test('selection buckets align with the latest ten-minute constraint',()=>{
  expect(new Date(jobBucket('select',Date.parse('2026-10-07T05:59:00Z'))).toISOString()).toBe('2026-10-07T05:50:00.000Z');
  expect(new Date(jobBucket('select',Date.parse('2026-10-07T18:01:00Z'))).toISOString()).toBe('2026-10-07T18:00:00.000Z');
  expect(new Date(jobBucket('discover',Date.parse('2026-10-07T12:15:00Z'))).toISOString()).toBe('2026-10-07T12:00:00.000Z');
});

test('Retry-After cooldown is shared with another invocation',async()=>{
  await store.cooldown('info',13000);expect((await new PgIngestStore(db).reserve('info',20)).waitMs).toBeGreaterThan(12000);
  expect((await store.reserve('rpc',1)).id).toBeDefined();
});

test('priority budget blocks background reservations but permits mirror and priority work',async()=>{
  const c=(await store.claimJob('priority',5))!;
  expect((await store.reserve('info',20)).id).toBeUndefined();
  expect((await store.budget('priority').reserve('info',20)).id).toBeDefined();
  expect((await store.budget('mirror').reserve('info',2)).id).toBeDefined();
  await store.finish(c,'complete',{});expect((await store.reserve('info',20)).id).toBeDefined();
});
test('priority keeps fill evidence at its original age; it never makes old fills fresh',async()=>{
  await seed(1);await save(1,now-3600_000);const row=(await store.accounts())[0],oldAsOf=row.stats!.asOf;
  await db.query("update public.ingest_accounts set claim_token='priority',claim_until=now()+interval '1 minute'");
  const raw=portfolio(now),fetchedAt=new Date(now).toISOString();
  await store.saveAccount(row.address,'priority',{raw,fetchedAt,...prepareHistory(row,raw,fetchedAt),classification:row.classification!,keepStats:true});
  const after=(await store.accounts())[0];expect(after.stats?.asOf).toBe(oldAsOf);expect(new Date(after.fetched_at!).getTime()).toBe(now);
});
test('both vaults and traders: 200 refreshed -> teammate Score 25 -> durable Agent job -> validated analysis',async()=>{
  const count=205,base=Date.now()-5000;await seed(count);
  function varied(n:number){
    let state=n*7919,value=12000,pnl=0;const points:any[]=[],pnls:any[]=[];
    for(let i=0;i<45;i++){
      state=(Math.imul(state,1664525)+1013904223)>>>0;const gain=((state/4294967296)-0.42)*100;
      value+=gain;pnl+=gain;points.push([base-(44-i)*DAY,String(value)]);pnls.push([base-(44-i)*DAY,String(pnl)]);
    }
    return ['month','allTime'].map(w=>[w,{accountValueHistory:points,pnlHistory:pnls,vlm:'100000'}]);
  }
  for(let n=1;n<=count;n++){
    const raw=varied(n),fetchedAt=new Date(base).toISOString(),kind=n<=10?'hypercore-vault':'trader';
    await db.query("update public.ingest_accounts set classification=$2::jsonb,refreshed_at=$3,evidence_refreshed_at=$3 where address=$1",
      [address(n),JSON.stringify({kind,evidence:n<=10?'vault-list':'no-hyperevm-code'}),fetchedAt]);
    await db.query('insert into public.ingest_portfolios(address,fetched_at,portfolio) values($1,$2,$3::jsonb)',[address(n),fetchedAt,JSON.stringify(raw)]);
    await db.query('insert into public.ingest_fill_stats(address,checked_at,stats) values($1,$2,$3::jsonb)',[address(n),fetchedAt,JSON.stringify({asOf:fetchedAt,startTime:base-30*DAY,endTime:base,
      tradeCount:12,orderCount:12,fills:12,pages:1,complete:true,makerShare:0.5,medianHoldHours:1,flags:[]})]);
  }
  let portfolios=0,positions=0;
  const source=transport((_u,b)=>{
    if(b.type==='portfolio'){portfolios++;return varied(parseInt(b.user.slice(2),16));}
    if(b.type==='clearinghouseState'){positions++;return {assetPositions:[]};}
    throw new Error('unexpected source request');
  });
  const modelFetch:Transport=async(_u,init)=>{
    const request=JSON.parse(String(init!.body)),input=JSON.parse(request.messages[1].content);
    expect(input.candidates).toHaveLength(25);expect(input.candidates.some((c:any)=>c.kind==='HYPERCORE_VAULT')).toBe(true);
    const body={candidates:input.candidates.map((c:any)=>({candidate:c.candidate,strategy:'Behavior requires more evidence',confidence:'low',
      evidence:[{field:'metrics.makerShare',observation:'Known maker share'}],risks:['Limited observation'],unknowns:['Entry signals']}))};
    return Response.json({choices:[{finish_reason:'stop',message:{content:JSON.stringify(body)}}]});
  };
  const pipeline=new IngestPipeline(store,Date.now,signal=>new BudgetClient(budget,signal,source),{provider:'openai',model:'test',apiKey:'test',fetcher:modelFetch});
  const priority=await pipeline.run('priority',new AbortController().signal);
  expect(priority.expected).toBe(200);expect(priority.updated).toBe(200);expect(portfolios).toBe(200);
  const coverage=(await db.query('select coverage from public.score_runs'))[0].coverage;
  expect(coverage.cohortPools.vaults).toBeGreaterThan(0);expect(coverage.cohortPools.traders).toBeGreaterThan(0);
  expect(coverage.finalistPools.vaults).toBeGreaterThan(0);expect(coverage.finalistPools.traders).toBeGreaterThan(0);
  const [job]=await db.query('select * from public.ingest_agent_jobs');expect(job.payload.accounts).toHaveLength(25);
  expect(job.payload.frame.candidates.some((c:any)=>c.kind==='HYPERCORE_VAULT')).toBe(true);
  expect(job.payload.frame.candidates.some((c:any)=>c.kind==='TRADER')).toBe(true);
  expect((await pipeline.run('agent',new AbortController().signal)).status).toBe('complete');expect(positions).toBe(50);
  expect((await db.query('select state,result from public.ingest_agent_jobs'))[0].result.economicAuthority).toBe(false);
  expect((await pipeline.run('agent',new AbortController().signal)).status).toBe('already-claimed');
},30_000);

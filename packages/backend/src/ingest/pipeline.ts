import {scoreCandidates,toFrameCandidates} from '../score';
import {checkFunnelArtifact,type FunnelArtifact} from '../../../shared/dashboard';
import {BudgetClient,SOURCES} from './client';
import {classify} from './classify';
import {discover} from './discovery';
import {prepareHistory,toScoreInput,loadInputs} from './loader';
import {PgIngestStore,type Account,type Claim,type Job} from './store';
import {runAgentJob,type AgentOptions} from './strategy-agent';
export function jobBucket(job:Job,ms:number){
  if(job==='discover')return Math.floor(ms/43_200_000)*43_200_000;
  return Math.floor(ms/(job==='refresh'||job==='agent'?300_000:600_000))*(job==='refresh'||job==='agent'?300_000:600_000);
}
export class IngestPipeline{
  constructor(readonly store:PgIngestStore,private now=Date.now,
    private clientFactory=(signal:AbortSignal,lane:'background'|'priority'|'mirror')=>new BudgetClient(store.budget(lane),signal),
    private agentOptions?:AgentOptions){}
  async run(job:Job,signal:AbortSignal,bucket=jobBucket(job,this.now())):Promise<Record<string,unknown>>{
    const started=this.now(),claim=await this.store.claimJob(job,bucket);if(!claim)return {status:'already-claimed'};
    try{
      if(job==='discover')return await this.discovery(claim,signal);
      if(!await this.store.registryReady())return await this.waiting(claim,{reason:'Discovery must finish first'});
      if(job==='agent'){
        const summary=await runAgentJob(this.store,this.clientFactory(signal,'priority'),this.agentOptions,signal,this.now());
        await this.store.finish(claim,summary.status==='waiting'?'waiting':'complete',summary);return summary;
      }
      if(job==='select')return await this.select(claim,signal);
      return await this.refresh(claim,signal,started,job==='priority');
    }catch(e){
      await this.store.finish(claim,'failed',{reason:signal.aborted?'Invocation deadline':(e as Error).message.slice(0,200)}).catch(()=>{});throw e;
    }
  }
  private async waiting(c:Claim,summary:object){await this.store.finish(c,'waiting',summary);return {status:'waiting',...summary};}
  private async discovery(claim:Claim,signal:AbortSignal){
    const client=this.clientFactory(signal,'background');
    const [leaderboard,vaults]=await Promise.all([client.request(SOURCES.leaderboard,undefined,1),client.request(SOURCES.vaults,undefined,1)]);
    const result=discover(leaderboard,vaults);signal.throwIfAborted();
    const summary={accounts:result.candidates.length,leaderboardRows:result.leaderboardRows,vaultRows:result.vaultRows};
    await this.store.saveDiscovery(claim,result.candidates,summary);return {status:'complete',...summary};
  }
  private async refresh(claim:Claim,parent:AbortSignal,started:number,priority:boolean){
    let updated=0,failed=0,block:`0x${string}`|undefined;
    let addresses:string[]|undefined;
    if(priority){
      const {inputs,coverage}=loadInputs(await this.store.accounts(),this.now());
      if(coverage.fraction<0.95)return this.waiting(claim,{...coverage,reason:'Global 12-hour coverage below 95%'});
      // Only the size of the research cohort changes. The teammate's scoring, pool split and clone rules remain intact.
      addresses=scoreCandidates(inputs,{finalists:200}).finalists;
    }
    parent.throwIfAborted();
    const refreshStarted=this.now(),signal=AbortSignal.any([parent,AbortSignal.timeout(priority?240_000:285_000)]);
    const client=this.clientFactory(signal,priority?'priority':'background');
    let index=0;
    const worker=async()=>{
    while(!signal.aborted&&this.now()-refreshStarted<(priority?235_000:280_000)){
      if(addresses&&index>=addresses.length)break;
      const row=await this.store.claimAccount(claim.token,claim.startedAt,addresses?.[index++],priority?'any':'portfolio');
      if(!row){if(addresses){failed++;continue;}break;}
      try{
        let classification=row.classification;
        if(!classification){
          if(row.candidate.knownHypercoreVault)classification={kind:'hypercore-vault',evidence:'vault-list'};
          else{
            if(!block){if(await client.rpc('eth_chainId',[])!=='0x3e7')throw new Error('Unexpected HyperEVM chain');block=await client.rpc('eth_blockNumber',[]);}
            classification=await classify(row.candidate,client,block);
          }
          await this.store.saveClassification(row.address,claim.token,classification);
        }
        const raw=await client.request(SOURCES.info,{type:'portfolio',user:row.address}),fetchedAt=new Date(this.now()).toISOString();
        const {history,flags}=prepareHistory(row,raw,fetchedAt);
        toScoreInput({...row,portfolio:raw,fetched_at:fetchedAt,history,classification,stats:null},this.now());
        signal.throwIfAborted();await this.store.saveAccount(row.address,claim.token,{raw:(raw as [string,unknown][]).filter(([name])=>name==='month'||name==='allTime'),
          fetchedAt,history,flags,classification,keepStats:true});updated++;
      }catch(e){await this.store.failAccount(row.address,claim.token,signal.aborted?'Invocation deadline':(e as Error).message);failed++;
        if(signal.aborted)break;}
    }
    };
    // Overlap network/SQL latency; every worker still reserves from the same locked minute budget.
    await Promise.all(Array.from({length:4},()=>worker()));
    const summary={updated,failed,requests:client.requests,infoWeight:client.infoWeight,rpcRequests:client.rpcRequests,retries:client.retries,rateLimited:client.rateLimited,
      elapsedMs:this.now()-started,deadlineReached:signal.aborted,...(addresses?{addresses,expected:addresses.length}:{}),
      completeCohort:addresses?updated===addresses.length:undefined};
    await this.store.finish(claim,'complete',summary);
    // Selection follows a fully refreshed cohort in this same ten-minute bucket. No partial cohort reaches the Agent.
    const selection=priority&&addresses?.length&&updated===addresses.length?
      await this.run('select',parent,claim.bucket).catch(()=>({status:'failed',reason:'Inspect the select job; priority refresh remains complete'})):undefined;
    return {status:'complete',...summary,...(selection?{selection}:{})};
  }
  private async select(claim:Claim,signal:AbortSignal){
    const priority=await this.store.latestPriority(claim.bucket);
    if(!priority?.summary.completeCohort||!priority.summary.addresses?.length)return this.waiting(claim,{reason:'This ten-minute priority cohort is not complete'});
    const asOf=this.now(),allRows=await this.store.accounts(),all=loadInputs(allRows,asOf);signal.throwIfAborted();
    if(all.coverage.fraction<0.95)return this.waiting(claim,all.coverage);
    const ids=new Set<string>(priority.summary.addresses),rows=allRows.filter(r=>ids.has(r.address));
    const fresh=rows.filter(r=>new Date(r.fetched_at!).getTime()>=new Date(priority.started_at).getTime()
      &&new Date(r.fetched_at!).getTime()>=asOf-600_000);
    const {inputs,issues}=loadInputs(fresh,asOf);
    if(inputs.length!==ids.size)return this.waiting(claim,{reason:'Priority data no longer fresh',expected:ids.size,fresh:inputs.length});
    const result=scoreCandidates(inputs);signal.throwIfAborted();
    const counts=(candidates:typeof result.candidates)=>({traders:candidates.filter(c=>c.pool==='trader').length,vaults:candidates.filter(c=>c.pool==='vault').length});
    const coverage={...all.coverage,priorityCount:ids.size,scored:inputs.length,scope:'refreshed-high-score-cohort',
      cohortPools:counts(result.candidates),finalistPools:counts(result.candidates.filter(c=>c.finalist))};
    const funnel:FunnelArtifact={generatedAt:asOf,steps:[{stage:'registry',label:'Discovered accounts',count:coverage.total},
      ...result.funnel.map(step=>({...step,label:step.stage}))],
      finalists:result.candidates.filter(c=>c.finalist).map(c=>({address:c.address,kind:c.kind,score:c.score!,picked:false,
        rationale:'Score finalist; strategy analysis queued, no trading authority'}))};
    const errors=checkFunnelArtifact(funnel);if(errors.length)throw new Error(errors.join('; '));
    const frame=toFrameCandidates(result);
    const payload={schemaVersion:'1.0.0',asOfMs:asOf,scope:coverage.scope,frame,
      accounts:result.finalists.map(address=>{
        const input=inputs.find(i=>i.address===address)!,row=rows.find(r=>r.address===address)!;
        const points=input.month!.pnlHistory;
        return {address,portfolioAsOf:row.fetched_at,fillStats:row.stats,
          curve:Array.from({length:Math.min(48,points.length)},(_,i)=>points[Math.round(i*(points.length-1)/(Math.min(48,points.length)-1))])};
      })};
    await this.store.publish(claim,coverage,result,issues,funnel,result.finalists.length?payload:undefined);
    return {status:'complete',...coverage,eligible:result.candidates.filter(c=>c.eligible).length,finalists:result.finalists.length,agent:result.finalists.length?'queued':'no-finalists'};
  }
}
export function ingestHandler(pipeline:IngestPipeline|undefined,secret:string|undefined){
  return async(req:Request,path:string):Promise<Response|null>=>{
    const match=/^\/cron\/(discover|refresh|priority|select|agent)$/.exec(path);if(!match)return null;
    if(req.method!=='GET')return new Response('method not allowed',{status:405});
    if(!secret||!pipeline)return Response.json({error:'DATABASE_URL and CRON_SECRET required'},{status:503});
    if(req.headers.get('authorization')!==`Bearer ${secret}`)return Response.json({error:'unauthorized'},{status:401});
    try{return Response.json(await pipeline.run(match[1] as Job,AbortSignal.timeout(match[1]==='priority'?480_000:290_000)));}
    catch{return Response.json({error:'Ingest job failed; inspect ingest_runs summary'},{status:502});}
  };
}

import type { SQL } from 'bun';
import type { Budget } from './client';
import type { Candidate, KindResult } from './types';
import type { HistoryRow } from './history';
import type { FillStats } from './fills';

export interface Database {
  query<T=Record<string,any>>(text:string,values?:unknown[]):Promise<T[]>;
  transaction<T>(fn:(db:Database)=>Promise<T>):Promise<T>;
}
export function bunDatabase(sql:SQL):Database {
  return {query:async(text,values=[])=>await sql.unsafe(text,values),
    transaction:fn=>sql.begin(tx=>fn(bunDatabase(tx as unknown as SQL))) as Promise<Awaited<ReturnType<typeof fn>>>};
}
export type Job='discover'|'refresh'|'priority'|'select'|'agent';
export type Claim={job:Job;bucket:number;token:string;startedAt:string};
export type Account={address:string;candidate:Candidate;classification:KindResult|null;portfolio:unknown|null;
  fetched_at:Date|string|null;history:HistoryRow[];history_flags:string[];stats:FillStats|null;refreshed_at:Date|string|null};
const j=(value:unknown)=>JSON.stringify(value);
const ACTIVE="a.last_seen=(select max(last_seen) from public.ingest_accounts)";

export class PgIngestStore implements Budget {
  constructor(readonly db:Database){}
  async claimJob(job:Job,bucket:number):Promise<Claim|null>{
    const token=crypto.randomUUID();
    const rows=await this.db.query(`insert into public.ingest_runs(job,bucket,token,status,claim_until)
      values($1,$2,$3,'running',now()+interval '600 seconds') on conflict(job,bucket) do update
      set token=excluded.token,status='running',claim_until=excluded.claim_until,started_at=now(),finished_at=null
      where ingest_runs.status in ('failed','waiting') or (ingest_runs.status='running' and ingest_runs.claim_until<now())
      returning token,started_at`,[job,bucket,token]);
    return rows.length?{job,bucket,token,startedAt:new Date(rows[0].started_at).toISOString()}:null;
  }
  async finish(c:Claim,status:'complete'|'failed'|'waiting',summary:unknown,db=this.db){
    const rows=await db.query(`update public.ingest_runs set status=$4,summary=$5::jsonb,finished_at=now()
      where job=$1 and bucket=$2 and token=$3 and status='running' and claim_until>now() returning token`,[c.job,c.bucket,c.token,status,j(summary)]);
    if(!rows.length)throw new Error('Cron claim lost');
  }
  async saveDiscovery(c:Claim,candidates:Candidate[],summary:object){
    return this.db.transaction(async db=>{
      // Finish and replace the active registry in one transaction. A late older job cannot retire newer discoveries.
      await this.finish(c,'complete',summary,db);
      await db.query("select pg_advisory_xact_lock(8142049)");
      const newer=await db.query("select 1 from public.ingest_runs where job='discover' and status='complete' and bucket>$1",[c.bucket]);
      if(newer.length)return;
      await db.query(`insert into public.ingest_accounts(address,candidate,classification,last_seen)
        select item->>'address',item,case when (item->>'knownHypercoreVault')::boolean
        then '{"kind":"hypercore-vault","evidence":"vault-list"}'::jsonb else null end,now()
        from jsonb_array_elements($1::jsonb) item
        on conflict(address) do update set candidate=excluded.candidate,last_seen=excluded.last_seen,
        classification=case when excluded.classification is not null then excluded.classification
          when ingest_accounts.classification->>'kind'='hypercore-vault' then null else ingest_accounts.classification end`,[j(candidates)]);
    });
  }
  async registryReady(){return (await this.db.query("select 1 from public.ingest_runs where job='discover' and status='complete' limit 1")).length>0;}
  async claimAccount(token:string,before:string,address?:string,stage:'any'|'portfolio'='any'):Promise<Account|null>{
    const rows=await this.db.query<{address:string}>(`with next as (
      select address from public.ingest_accounts a where ${ACTIVE} and ($3::text is null or a.address=$3)
        and ($3::text is not null or $4<>'any' or attempted_at is null or attempted_at<$2::timestamptz)
        and ($3::text is not null or $4='any'
          or ($4='portfolio' and (refreshed_at is null or refreshed_at<now()-interval '11 hours')))
        and (claim_until is null or claim_until<now() or ($3::text is not null and exists(
          select 1 from public.ingest_runs r where r.job='refresh' and r.token=a.claim_token))) and (retry_at is null or retry_at<=now())
      order by refreshed_at nulls first,attempted_at nulls first,address for update skip locked limit 1)
      update public.ingest_accounts a set claim_token=$1,claim_until=now()+interval '600 seconds',attempted_at=now()
      from next where a.address=next.address returning a.address`,[token,before,address??null,stage]);
    if(!rows.length)return null;
    return (await this.accounts(rows[0].address))[0];
  }
  async accounts(address?:string):Promise<Account[]>{
    return this.db.query<Account>(`select a.address,a.candidate,a.classification,a.refreshed_at,p.portfolio,p.fetched_at,
      coalesce(p.history,'[]'::jsonb) history,coalesce(p.history_flags,'[]'::jsonb) history_flags,f.stats
      from public.ingest_accounts a left join public.ingest_portfolios p using(address)
      left join public.ingest_fill_stats f using(address) where ${address?'a.address=$1':ACTIVE} order by a.address`,address?[address]:[]);
  }
  async saveClassification(address:string,token:string,classification:KindResult){
    const rows=await this.db.query(`update public.ingest_accounts set classification=$3::jsonb
      where address=$1 and claim_token=$2 and claim_until>now() returning address`,[address,token,j(classification)]);
    if(!rows.length)throw new Error('Account claim lost');
  }
  async saveAccount(address:string,token:string,data:{raw:unknown;fetchedAt:string;history:HistoryRow[];flags:string[];
    classification:KindResult;stats?:FillStats;keepStats?:boolean}){
    await this.db.transaction(async db=>{
      const updated=await db.query(`update public.ingest_accounts set classification=$3::jsonb,refreshed_at=$4,
        evidence_refreshed_at=case when $5 then evidence_refreshed_at else $4::timestamptz end,
        failures=0,last_error=null,retry_at=null,claim_token=null,claim_until=null
        where address=$1 and claim_token=$2 and claim_until>now() returning address`,[address,token,j(data.classification),data.fetchedAt,data.keepStats??false]);
      if(!updated.length)throw new Error('Account claim lost');
      await db.query(`insert into public.ingest_portfolios(address,fetched_at,portfolio,history,history_flags)
        values($1,$2,$3::jsonb,$4::jsonb,$5::jsonb) on conflict(address) do update set
        fetched_at=excluded.fetched_at,portfolio=excluded.portfolio,history=excluded.history,history_flags=excluded.history_flags`,
        [address,data.fetchedAt,j(data.raw),j(data.history),j(data.flags)]);
      // Priority refresh keeps cached evidence with its original timestamp; the loader enforces its age.
      if(data.stats)await db.query(`insert into public.ingest_fill_stats(address,checked_at,stats) values($1,$2,$3::jsonb)
        on conflict(address) do update set checked_at=excluded.checked_at,stats=excluded.stats`,[address,data.stats.asOf,j(data.stats)]);
      else if(!data.keepStats)await db.query('delete from public.ingest_fill_stats where address=$1',[address]);
    });
  }
  async failAccount(address:string,token:string,error:string){
    await this.db.query(`update public.ingest_accounts set failures=failures+1,last_error=$3,claim_until=null,claim_token=null,
      retry_at=now()+least(3600,60*power(2,least(failures,6)))*interval '1 second'
      where address=$1 and claim_token=$2`,[address,token,error.slice(0,200)]);
  }
  async reserve(scope:'info'|'rpc',weight:number,lane:'background'|'priority'|'mirror'='background'){
    const cap=scope==='info'?1200:100;
    if(!Number.isInteger(weight)||weight<=0||weight>cap)throw new Error('Invalid reservation');
    return this.db.transaction(async db=>{
      if(lane==='background'){
        const busy=await db.query("select 1 from public.ingest_runs where job='priority' and status='running' and claim_until>now() limit 1");
        if(busy.length)return {waitMs:250};
      }
      const [row]=await db.query("select reservations,blocked_until,extract(epoch from clock_timestamp())*1000 as ms from public.ingest_budget where id=1 for update");
      const now=Number(row.ms),all=(row.reservations as {id:string;scope:string;weight:number;time:number}[]).filter(r=>r.time>now-60_000);
      if(Number(row.blocked_until[scope])>now)return {waitMs:Math.ceil(Number(row.blocked_until[scope])-now)};
      const active=all.filter(r=>r.scope===scope).sort((a,b)=>a.time-b.time);
      let total=active.reduce((n,r)=>n+r.weight,0);
      if(total+weight>cap){for(const r of active){total-=r.weight;if(total+weight<=cap)return {waitMs:Math.max(1,Math.ceil(r.time+60_000-now)+20)};}}
      const id=crypto.randomUUID();all.push({id,scope,weight,time:now});
      await db.query('update public.ingest_budget set reservations=$1::jsonb where id=1',[j(all)]);
      return {id,waitMs:0};
    });
  }
  budget(lane:'background'|'priority'|'mirror'):Budget{
    return {reserve:(scope,weight)=>this.reserve(scope,weight,lane),refund:(id,actual)=>this.refund(id,actual),cooldown:(scope,ms)=>this.cooldown(scope,ms)};
  }
  async latestPriority(bucket:number){
    return (await this.db.query("select summary,started_at from public.ingest_runs where job='priority' and bucket=$1 and status='complete'",[bucket]))[0];
  }
  async cooldown(scope:'info'|'rpc',ms:number){
    await this.db.query(`update public.ingest_budget set blocked_until=jsonb_set(blocked_until,array[$1],
      to_jsonb(greatest(coalesce((blocked_until->>$1)::numeric,0),extract(epoch from clock_timestamp())*1000+$2))) where id=1`,[scope,ms]);
  }
  async refund(id:string,actual:number){
    await this.db.transaction(async db=>{
      const [row]=await db.query('select reservations from public.ingest_budget where id=1 for update');
      const all=row.reservations as {id:string;weight:number}[],entry=all.find(r=>r.id===id);
      if(entry&&Number.isInteger(actual)&&actual>0&&actual<=entry.weight){entry.weight=actual;
        await db.query('update public.ingest_budget set reservations=$1::jsonb where id=1',[j(all)]);}
    });
  }
  async publish(c:Claim,coverage:unknown,result:unknown,issues:unknown,funnel:{generatedAt:number},agentPayload?:unknown){
    await this.db.transaction(async db=>{
      await this.finish(c,'complete',coverage,db);
      await db.query(`insert into public.score_runs(bucket,generated_at,coverage,result,input_issues)
        values($1,$2,$3::jsonb,$4::jsonb,$5::jsonb) on conflict(bucket) do nothing`,
        [c.bucket,new Date(funnel.generatedAt).toISOString(),j(coverage),j(result),j(issues)]);
      if(agentPayload)await db.query(`insert into public.ingest_agent_jobs(bucket,payload) values($1,$2::jsonb)
        on conflict(bucket) do nothing`,[c.bucket,j(agentPayload)]);
      await db.query(`insert into public.dashboard_artifacts(name,body) values('funnel',$1::jsonb)
        on conflict(name) do update set body=excluded.body,updated_at=now()
        where coalesce((dashboard_artifacts.body->>'generatedAt')::bigint,0)<($1::jsonb->>'generatedAt')::bigint`,[j(funnel)]);
    });
  }
}

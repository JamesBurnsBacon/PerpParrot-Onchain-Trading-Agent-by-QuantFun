/** Operator-only, one-time bridge from the preserved research cache. Never imported by the cron server. */
import {Database as Sqlite} from 'bun:sqlite';
import {SQL} from 'bun';
import {z} from 'zod';
import {addressSchema,decimalSchema,type Candidate,type KindResult} from './types';
import {parsePortfolio} from '../score';
import {bunDatabase,type Database} from './store';
import type {FillStats} from './fills';
const candidateSchema=z.object({address:addressSchema,accountValueOrTvlUsd:decimalSchema,
  valueSource:z.enum(['leaderboard-account-value','hypercore-vault-tvl']),sources:z.array(z.enum(['leaderboard','hypercore-vault-list'])),
  name:z.string().nullable(),knownHypercoreVault:z.boolean(),leaderAddress:addressSchema.nullable()});
const classificationSchema=z.object({kind:z.enum(['trader','hypercore-vault','erc4626-vault']),
  evidence:z.enum(['vault-list','no-hyperevm-code','erc4626-probes','contract-probes-failed'])}).passthrough().nullable();
export function initialOrderStats(raw:unknown,endTime:number,asOf:string,sha256:string):FillStats&{sha256:string}{
  if(!Array.isArray(raw)||!Number.isSafeInteger(endTime)||endTime<0||!Number.isFinite(Date.parse(asOf))||endTime>Date.parse(asOf))throw new Error('Invalid initial evidence');
  const ids=new Set<string>();
  for(const f of raw){
    if(f&&typeof f.coin==='string'&&f.coin.length>0&&!f.coin.startsWith('@')&&!f.coin.includes('/')
      &&Number.isSafeInteger(f.time)&&f.time>=0&&f.time<=endTime&&Number.isSafeInteger(f.oid)&&f.oid>=0
      &&decimalSchema.safeParse(f.sz).success&&Number(f.sz)>0&&Number.isFinite(Number(f.sz)))ids.add(`${f.coin}:${f.oid}`);
  }
  return {asOf,startTime:0,endTime,orderCount:ids.size,tradeCount:ids.size>=10?ids.size:null,fills:raw.length,pages:1,
    complete:false,makerShare:null,medianHoldHours:null,sha256,flags:['initial-screening-order-lower-bound','maker-hold-not-collected']};
}
export type CachedScreening={candidate:Candidate;classification:KindResult|null;portfolio:unknown;fetchedAt:string;stats:FillStats|null};
export function* readScreeningCache(source:Sqlite,now=Date.now()):Generator<CachedScreening>{
  const blob=source.query<{raw:string},[string]>('select raw from blobs where hash=?');
  const read=(hash:string)=>{
    if(typeof hash!=='string'||!/^[a-f0-9]{64}$/.test(hash))throw new Error('Invalid cache hash');
    const row=blob.get(hash);if(!row||new Bun.CryptoHasher('sha256').update(row.raw).digest('hex')!==hash)throw new Error('Corrupt initial evidence');
    return JSON.parse(row.raw);
  };
  for(const row of source.query<{body:string},[]>('select body from accounts order by address').iterate()){
    const a=JSON.parse(row.body),candidate=candidateSchema.parse(a.candidate),classification=classificationSchema.parse(a.classification);
    if(candidate.address!==addressSchema.parse(a.input.address)||(classification&&classification.kind!==a.input.kind))throw new Error('Cache identity mismatch');
    if(!Number.isFinite(Date.parse(a.fetchedAt))||Date.parse(a.fetchedAt)>now)throw new Error('Invalid cache timestamp');
    const portfolio=read(a.rawHash),windows=parsePortfolio(portfolio),end=windows.month?.pnlHistory.at(-1)?.[0];
    if(!end||end>now)throw new Error('Invalid portfolio endpoint');
    let stats:FillStats|null=null;
    if(a.fillsHash){
      if(!Number.isFinite(Date.parse(a.fillsCheckedAt))||Date.parse(a.fillsCheckedAt)>now)throw new Error('Invalid fill timestamp');
      // Bind observations to when they were collected, not today's newly refreshed portfolio endpoint.
      stats=initialOrderStats(read(a.fillsHash),Math.min(end,Date.parse(a.fillsCheckedAt)),a.fillsCheckedAt,a.fillsHash);
    }
    yield {candidate,classification:classification as KindResult|null,portfolio:(portfolio as [string,unknown][]).filter(([name])=>name==='month'||name==='allTime'),fetchedAt:a.fetchedAt,stats};
  }
}
export async function importScreeningRow(db:Database,row:CachedScreening){
  await db.transaction(async tx=>{
    const a=row.candidate.address,j=JSON.stringify;
    // New imported rows start inactive; official discovery controls registry membership.
    await tx.query(`insert into public.ingest_accounts(address,candidate,classification,last_seen)
      values($1,$2::jsonb,$3::jsonb,'epoch') on conflict(address) do update set
      classification=coalesce(ingest_accounts.classification,excluded.classification)`,[a,j(row.candidate),j(row.classification)]);
    const saved=await tx.query(`insert into public.ingest_portfolios(address,fetched_at,portfolio) values($1,$2,$3::jsonb)
      on conflict(address) do update set fetched_at=excluded.fetched_at,portfolio=excluded.portfolio
      where ingest_portfolios.fetched_at<excluded.fetched_at returning address`,[a,row.fetchedAt,j(row.portfolio)]);
    if(saved.length)await tx.query('update public.ingest_accounts set refreshed_at=$2 where address=$1',[a,row.fetchedAt]);
    if(row.stats){
      await tx.query(`insert into public.ingest_fill_stats(address,checked_at,stats) values($1,$2,$3::jsonb)
        on conflict(address) do nothing`,[a,row.stats.asOf,j(row.stats)]);
      await tx.query('update public.ingest_accounts set evidence_refreshed_at=coalesce(evidence_refreshed_at,$2) where address=$1',[a,row.stats.asOf]);
    }
  });
}
if(import.meta.main){
  const args=Bun.argv.slice(2),sourcePath=args[args.indexOf('--source')+1],apply=args.includes('--apply');
  if(!args.includes('--source')||!sourcePath||sourcePath.startsWith('--')||(!apply&&!args.includes('--check-only')))throw new Error('Use --source CACHE.sqlite --check-only (or --apply with DATABASE_URL)');
  if(apply&&!process.env.DATABASE_URL)throw new Error('DATABASE_URL required for --apply');
  const source=new Sqlite(sourcePath,{readonly:true,strict:true}),sql=apply?new SQL(process.env.DATABASE_URL!):undefined;
  let accounts=0,withTradeEvidence=0,vaults=0;
  try{
    source.exec('BEGIN');
    for(const row of readScreeningCache(source)){
      if(sql)await importScreeningRow(bunDatabase(sql),row);
      accounts++;if(row.stats?.tradeCount!==null&&row.stats?.tradeCount!==undefined)withTradeEvidence++;
      if(row.classification?.kind&&row.classification.kind!=='trader')vaults++;
    }
    source.exec('COMMIT');console.log(JSON.stringify({mode:apply?'imported':'validated',accounts,withTradeEvidence,vaults,networkSourceRequests:0}));
  }finally{source.close();await sql?.close();}
}

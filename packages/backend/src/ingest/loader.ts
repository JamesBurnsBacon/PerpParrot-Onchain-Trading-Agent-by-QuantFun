import {parsePortfolio,validateSeries,computeFilters,DEFAULT_CONFIG,type ScoreInput} from '../score';
import {historyBefore,mergeHistory,normalizedMonth} from './history';
import type {Account} from './store';
const DAY=86_400_000;
export function prepareHistory(row:Account,raw:unknown,fetchedAt:string){
  const now=Date.parse(fetchedAt),current=normalizedMonth(row.address,raw,fetchedAt,'latest'),parsed=parsePortfolio(raw);
  if([parsed.month,parsed.allTime].some(w=>w!.accountValueHistory.some(([t,v])=>t>now||v<0)))throw new Error('Future or negative portfolio point');
  const old=row.history.filter(p=>p.tsMs>=now-90*DAY);
  if(old.some(p=>p.address!==row.address||!Number.isFinite(p.accountValue)||!Number.isFinite(p.pnlAllTime)||p.tsMs>now
    ||!Number.isFinite(Date.parse(p.fetchedAt))||Date.parse(p.fetchedAt)>now))throw new Error('Invalid stored history');
  const merged=mergeHistory([...old,...current]),conflict=merged.mismatches.length>0;
  return {history:(conflict?current:merged.rows).filter(p=>p.tsMs>=now-90*DAY),flags:conflict?['older-history-conflict']:[]};
}
export function toScoreInput(row:Account,asOf:number):ScoreInput{
  const fetched=Date.parse(String(row.fetched_at instanceof Date?row.fetched_at.toISOString():row.fetched_at));
  if(!Number.isFinite(fetched)||fetched>asOf||fetched<asOf-12*3_600_000)throw new Error('Portfolio outside 12-hour freshness window');
  if(!row.classification||!['trader','hypercore-vault','erc4626-vault'].includes(row.classification.kind))throw new Error('Missing classification');
  const {month,allTime}=parsePortfolio(row.portfolio);
  if(!validateSeries(month)||!validateSeries(allTime))throw new Error('Invalid scoring windows');
  if(month.accountValueHistory.at(-1)![0]<asOf-12*3_600_000)throw new Error('Portfolio source endpoint stale');
  const normalized=prepareHistory(row,row.portfolio,new Date(fetched).toISOString());
  // Initial observed order counts are durable lower bounds. Never refetch fills on a cron.
  const f=row.stats,baseline=f&&Number.isFinite(Date.parse(f.asOf))&&f.endTime<=asOf
    &&f.startTime>=0&&f.startTime<=f.endTime&&f.endTime<=Date.parse(f.asOf)&&Date.parse(f.asOf)<=asOf;
  const recentDetails=baseline&&f.endTime>=asOf-12*3_600_000&&f.startTime===f.endTime-30*DAY;
  return {address:row.address,kind:row.classification.kind,accountValue:month.accountValueHistory.at(-1)![1],
    closed:row.classification.kind==='erc4626-vault'?null:false,month,allTime,
    history:historyBefore(normalized.history,row.address,month.accountValueHistory[0][0]),
    tradeCount:baseline?f.tradeCount:null,makerShare:recentDetails?f.makerShare:null,medianHoldHours:recentDetails?f.medianHoldHours:null,
    ...(row.candidate.leaderAddress?{links:[row.candidate.leaderAddress]}:{})};
}
export function needsFills(input:ScoreInput){
  const gates=computeFilters(input,null,DEFAULT_CONFIG);
  return (['minAccountValue','minActiveDays','stillActive','notClosed','minMonthPoints'] as const).every(k=>gates[k]==='pass');
}
export function loadInputs(rows:Account[],asOf:number){
  const inputs:ScoreInput[]=[],issues:{address:string;reason:string}[]=[];
  for(const row of rows){try{inputs.push(toScoreInput(row,asOf));
    for(const reason of [...row.history_flags,...(row.stats?.flags??[])])issues.push({address:row.address,reason});}catch(e){issues.push({address:row.address,reason:(e as Error).message});}}
  const ages=rows.map(r=>asOf-Date.parse(String(r.refreshed_at instanceof Date?r.refreshed_at.toISOString():r.refreshed_at)))
    .filter(n=>Number.isFinite(n)&&n>=0).sort((a,b)=>a-b);
  const coverage={total:rows.length,fresh:inputs.length,fraction:rows.length?inputs.length/rows.length:0,
    oldestHours:ages.length?ages.at(-1)!/3_600_000:null,medianHours:ages.length?ages[Math.floor(ages.length/2)]/3_600_000:null,
    fillEvidenceMode:'initial-screening-cache',
    missingFills:inputs.filter(i=>needsFills(i)&&i.tradeCount===null).length,asOf:new Date(asOf).toISOString()};
  return {inputs,issues,coverage};
}

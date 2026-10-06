import { DEFAULT_CONFIG } from '../src/score/config';
import { buildSeries, DAY_MS, type SeriesPoint } from '../src/score/stitch';
import { computeIntervals } from '../src/score/returns';
import type { ScoreInput, WindowHistory } from '../src/score/types';
import type { Candidate } from '../../shared/src/contracts';
import { isDeepStrictEqual } from 'node:util';

/** Normalized public userFillsByTime fields. tid identifies a fill, oid an order. */
export interface NormalizedFill {
  coin: string; time: number; sz: string; px: string; startPosition: string;
  side: 'B' | 'A'; crossed: boolean; tid: number; oid?: number;
}
/** Some spot responses reuse tid=0. Preserve distinct executions while still
 * detecting conflicting copies of the same execution at pagination boundaries. */
export function fillIdentity(f: NormalizedFill): string {
  return JSON.stringify([f.coin, f.tid, f.time, f.oid ?? null, f.side]);
}
export interface FillCoverage {
  rows: NormalizedFill[]; startMs: number; endMs: number; complete: boolean;
  /** Collector attestations: all pages retained and same-timestamp caps resolved. */
  pages: { requestStartMs: number; requestEndMs: number; rawSha256: string; count: number;
    firstFillMs?: number; lastFillMs?: number }[];
  missingReasons?: string[];
}
export interface ClearinghouseEvidence {
  asOfMs: number; complete: boolean; accountValueUsd: number; rawSha256: string[];
  positions: { coin: string; size: number; signedNotionalUsd: number;
    configuredLeverage: number | null; liquidationDistance: number | null }[];
}
export interface LeverageSample {
  atMs: number; equityUsd: number; grossNotionalUsd: number; rawSha256: string[];
}
export interface MeasureAccountArgs {
  input: ScoreInput; asOfMs: number; fills: FillCoverage; clearinghouse: ClearinghouseEvidence;
  /** Fixed adjacent trailing holdouts, oldest first. No best-window search. */
  holdoutDays?: readonly [number, number]; leverageSamples?: LeverageSample[];
}
type MetricPatch = Partial<Candidate['metrics']>;
const hash = (x: string) => /^[a-f0-9]{64}$/.test(x);
const close = (a: number, b: number) => Math.abs(a - b) <= 1e-8 * Math.max(1, Math.abs(a), Math.abs(b));
const median = (xs: number[]) => { const x = [...xs].sort((a,b)=>a-b), n=x.length; return n ? (x[Math.floor((n-1)/2)]!+x[Math.floor(n/2)]!)/2 : null; };
const finite = (x: number) => Number.isFinite(x) ? x : null;
const side = (f: NormalizedFill) => (f.side === 'B' ? 1 : -1) * Number(f.sz);
const nextPosition = (f: NormalizedFill) => Number(f.startPosition) + side(f);

function validClearinghouse(c: ClearinghouseEvidence): boolean {
  return c.complete && Number.isSafeInteger(c.asOfMs) && c.asOfMs >= 0
    && Number.isFinite(c.accountValueUsd) && c.accountValueUsd >= 0
    && c.rawSha256.length > 0 && c.rawSha256.every(hash)
    && new Set(c.positions.map(p=>p.coin)).size === c.positions.length
    && c.positions.every(p=>typeof p.coin==='string' && p.coin.length>0 && Number.isFinite(p.size)
      && Number.isFinite(p.signedNotionalUsd) && Math.sign(p.size)===Math.sign(p.signedNotionalUsd)
      && (p.configuredLeverage===null || (Number.isFinite(p.configuredLeverage)&&p.configuredLeverage>0))
      && (p.liquidationDistance===null || (Number.isFinite(p.liquidationDistance)&&p.liquidationDistance>=0&&p.liquidationDistance<=1)));
}

function validCoverage(f: FillCoverage, asOfMs: number): boolean {
  if (!f.complete || !Number.isSafeInteger(f.startMs) || !Number.isSafeInteger(f.endMs)
    || f.startMs >= f.endMs || f.endMs > asOfMs || asOfMs-f.endMs>300_000 || !f.pages.length
    || f.missingReasons?.length) return false;
  let covered = f.startMs;
  for (const p of [...f.pages].sort((a,b)=>a.requestStartMs-b.requestStartMs)) {
    if (!hash(p.rawSha256) || !Number.isSafeInteger(p.count) || p.count < 0
      || !Number.isSafeInteger(p.requestStartMs) || !Number.isSafeInteger(p.requestEndMs)
      || p.requestStartMs > covered + 1 || p.requestStartMs > p.requestEndMs) return false;
    covered = Math.max(covered, p.requestEndMs);
  }
  const pages=[...f.pages].sort((a,b)=>a.requestStartMs-b.requestStartMs);
  for(let i=0;i<pages.length;i++){
    const p=pages[i]!;
    if(p.count>2000)return false;
    if(p.count===2000){
      const next=pages[i+1];
      if(!next||!Number.isSafeInteger(p.lastFillMs)||next.requestStartMs>p.lastFillMs!)return false;
    }
  }
  return covered >= f.endMs;
}

function fillMetrics(f: FillCoverage, c: ClearinghouseEvidence, asOfMs: number) {
  const reasons: string[] = [], unique = new Map<string, NormalizedFill>();
  let complete = validCoverage(f, asOfMs);
  if (!complete) reasons.push('FILL_PAGINATION_INCOMPLETE');
  for (const row of f.rows) {
    // Public fills may contain spot trades. The Score field is specifically perp maker share.
    if(typeof row?.coin==='string'&&(row.coin.startsWith('@')||row.coin.includes('/')))continue;
    if (!row || !row.coin || !Number.isSafeInteger(row.time) || !Number.isSafeInteger(row.tid)
      || row.tid < 0 || (row.side !== 'B' && row.side !== 'A') || typeof row.crossed !== 'boolean'
      || ![row.sz,row.px,row.startPosition].every(v=>typeof v==='string' && v.trim()!=='' && Number.isFinite(Number(v)))
      || !(Number(row.sz)>0) || !(Number(row.px)>0)) {
      reasons.push('INVALID_FILL'); complete=false; continue;
    }
    if (row.time < f.startMs || row.time > f.endMs) { reasons.push('FILL_OUTSIDE_DECLARED_WINDOW'); complete=false; continue; }
    const key = fillIdentity(row), old=unique.get(key);
    if (old && !isDeepStrictEqual(old,row)) { reasons.push('CONFLICTING_DUPLICATE_FILL'); complete=false; }
    else unique.set(key,row);
  }
  const rows=[...unique.values()].sort((a,b)=>a.time-b.time||a.tid-b.tid);
  const recent=rows.filter(r=>r.time>=f.endMs-30*DAY_MS);
  const notional=recent.reduce((n,r)=>n+Number(r.sz)*Number(r.px),0);
  const maker=recent.filter(r=>!r.crossed).reduce((n,r)=>n+Number(r.sz)*Number(r.px),0);
  const byCoin=new Map<string,NormalizedFill[]>();
  for(const r of rows){const same=byCoin.get(r.coin);if(same)same.push(r);else byCoin.set(r.coin,[r]);}
  const periods:[number,number][]=[],closedDurations:number[]=[];
  let excludedCarryIn=0, openEpisodes=0, pathValid=complete;
  const positions=new Map(c.positions.map(p=>[p.coin,p]));
  for (const coin of new Set([...byCoin.keys(),...positions.keys()])) {
    const raw=byCoin.get(coin)??[];
    if (!raw.length) {
      if ((positions.get(coin)?.size??0)!==0) {periods.push([f.startMs,f.endMs]);excludedCarryIn++;openEpisodes++;}
      continue;
    }
    const ordered:NormalizedFill[]=[],remaining=[...raw];
    let previous:number|undefined, valid=true;
    while(remaining.length) {
      const time=remaining[0]!.time, group:NormalizedFill[]=[];
      while(remaining[0]?.time===time)group.push(remaining.shift()!);
      // Use startPosition continuity, never infer exchange order from an arbitrary ID.
      while(group.length) {
        const choices=group.filter(r=>previous===undefined
          ? !group.some(other=>other!==r&&close(nextPosition(other),Number(r.startPosition)))
          : close(Number(r.startPosition),previous));
        if(choices.length!==1){valid=false;break;}
        const r=choices[0]!;ordered.push(r);previous=nextPosition(r);group.splice(group.indexOf(r),1);
      }
      if(!valid)break;
    }
    if(!valid){reasons.push(`POSITION_PATH_AMBIGUOUS:${coin}`);pathValid=false;continue;}
    let pos=Number(ordered[0]!.startPosition),activeFrom=pos!==0?f.startMs:null;
    let opened:number|null=null;
    if(pos!==0)excludedCarryIn++;
    const durations:number[]=[],active:[number,number][]=[];
    for(const r of ordered) {
      const after=nextPosition(r),closed=pos!==0&&(close(after,0)||Math.sign(after)!==Math.sign(pos));
      if(closed){if(activeFrom!==null)active.push([activeFrom,r.time]);if(opened!==null)durations.push(r.time-opened);opened=null;activeFrom=null;}
      if(!close(after,0)&&(close(pos,0)||closed)){opened=r.time;activeFrom=r.time;}
      pos=close(after,0)?0:after;
    }
    if(!close(pos,positions.get(coin)?.size??0)) {reasons.push(`TERMINAL_POSITION_MISMATCH:${coin}`);pathValid=false;continue;}
    if(activeFrom!==null){active.push([activeFrom,f.endMs]);openEpisodes++;}
    periods.push(...active);closedDurations.push(...durations);
  }
  if(!validClearinghouse(c)||c.asOfMs>asOfMs||c.asOfMs<f.endMs||asOfMs-c.asOfMs>300_000){reasons.push('CURRENT_POSITION_COVERAGE_INCOMPLETE');pathValid=false;}
  periods.sort((a,b)=>a[0]-b[0]);
  let activeMs=0,end=f.startMs;
  for(const [a,b]of periods){activeMs+=Math.max(0,b-Math.max(end,a));end=Math.max(end,b);}
  const holding=pathValid?median(closedDurations):null;
  if(holding===null)reasons.push('NO_COMPLETE_OBSERVED_HOLDING_EPISODES');
  if(f.startMs>f.endMs-30*DAY_MS)reasons.push('MAKER_SHARE_LESS_THAN_30_DAYS_COVERAGE');
  return {makerShare:complete&&f.startMs<=f.endMs-30*DAY_MS&&notional>0?maker/notional:null,
    medianHoldHours:holding===null?null:holding/3_600_000,
    timeInMarket:pathValid?activeMs/(f.endMs-f.startMs):null,observedFills:rows.length,
    closedEpisodes:closedDurations.length,excludedCarryIn,openEpisodes,
    reasons:[...new Set(reasons)],complete:complete&&pathValid};
}

function clip(w:WindowHistory|null,at:number):WindowHistory|null {
  if(!w)return null;
  return {accountValueHistory:w.accountValueHistory.filter(p=>p[0]<=at),pnlHistory:w.pnlHistory.filter(p=>p[0]<=at)};
}
function summarize(points:SeriesPoint[]) {
  if(points.length<2)return null;
  const {intervals,flags}=computeIntervals(points,DEFAULT_CONFIG.dustEquityFraction);
  const used=intervals.filter(i=>i.used),time=used.reduce((n,i)=>n+i.dt,0);
  if(!(time>0))return null;
  const mean=used.reduce((n,i)=>n+i.r,0)/time;
  const sd=Math.sqrt(used.reduce((n,i)=>n+(i.r-mean*i.dt)**2,0)/time);
  const downside=Math.sqrt(used.reduce((n,i)=>n+Math.min(i.r,0)**2,0)/time);
  let capital=1,peak=1,drawdown=0;
  for(const i of used){capital=capital===0||i.r<=-1?0:capital*(1+i.r);peak=Math.max(peak,capital);drawdown=Math.max(drawdown,1-capital/peak);}
  return {startMs:points[0]!.ts,endMs:points.at(-1)!.ts,points:points.length,
    periodReturn:finite(capital-1),sharpe:sd>0?finite(mean/sd):null,
    sortino:downside>0?finite(mean/downside):null,maxDrawdown:finite(drawdown),
    coveredDays:time,maxGapDays:Math.max(...intervals.map(i=>i.dt)),flags};
}

/** Fixed retrospective temporal slices of a cohort discovered now; NOT a point-in-time universe backtest. */
export function temporalHoldouts(input:ScoreInput,asOfMs:number,days:readonly[number,number]=[14,14]) {
  if(days.some(d=>!Number.isSafeInteger(d)||d<7||d>90))throw new Error('invalid holdout duration');
  const clipped={...input,month:clip(input.month,asOfMs),allTime:clip(input.allTime,asOfMs),history:clip(input.history,asOfMs)};
  const series=buildSeries(clipped,{...DEFAULT_CONFIG,lookbackDays:Math.max(90,days[0]+days[1]+14)});
  let start=asOfMs-(days[0]+days[1])*DAY_MS;
  return days.map(duration=>{
    const end=start+duration*DAY_MS,plannedStartMs=start;start=end;
    // Split BEFORE dust peak, returns, or metric computation. Evaluation values never change training metrics.
    const training=summarize((series?.points??[]).filter(p=>p.ts<plannedStartMs));
    const evaluation=summarize((series?.points??[]).filter(p=>p.ts>=plannedStartMs&&p.ts<=end));
    const usable=!!training&&training.coveredDays>=14&&!!evaluation&&evaluation.points>=4
      &&evaluation.coveredDays>=duration*0.8&&evaluation.maxGapDays<=1.5
      &&!evaluation.flags.includes('dust-equity');
    return {plannedStartMs,plannedEndMs:end,training,evaluation,usable,
      scope:'RETROSPECTIVE_CURRENT_COHORT_TEMPORAL_HOLDOUT' as const,
      selection:'CURRENT_SNAPSHOT_NOT_POINT_IN_TIME' as const};
  });
}

function measureLeverage(samples:LeverageSample[],asOfMs:number) {
  const sorted=[...samples].sort((a,b)=>a.atMs-b.atMs);
  if(sorted.length<2||asOfMs-sorted.at(-1)!.atMs>300_000||sorted.some((s,i)=>!Number.isSafeInteger(s.atMs)||s.atMs<0||s.atMs>asOfMs
    ||!(s.equityUsd>0)||!Number.isFinite(s.equityUsd)||s.grossNotionalUsd<0||!Number.isFinite(s.grossNotionalUsd)
    ||!s.rawSha256.length||s.rawSha256.some(h=>!hash(h))||(i>0&&s.atMs<=sorted[i-1]!.atMs)))return null;
  const span=sorted.at(-1)!.atMs-sorted[0]!.atMs;
  if(span<600_000)return null;
  let weighted=0,maxGapMs=0;
  for(let i=1;i<sorted.length;i++){
    const a=sorted[i-1]!,b=sorted[i]!,dt=b.atMs-a.atMs;maxGapMs=Math.max(maxGapMs,dt);
    weighted+=dt*(a.grossNotionalUsd/a.equityUsd+b.grossNotionalUsd/b.equityUsd)/2;
  }
  if(!Number.isFinite(weighted/span))return null;
  return {average:weighted/span,startMs:sorted[0]!.atMs,endMs:sorted.at(-1)!.atMs,
    samples:sorted.length,maxGapMs,method:'TRAPEZOIDAL_SAMPLED_GROSS_NOTIONAL_OVER_EQUITY' as const,
    scope:'OBSERVED_SAMPLE_INTERVAL_ONLY' as const,rawSha256:sorted.flatMap(s=>s.rawSha256)};
}

export function measureAccountEvidence(args:MeasureAccountArgs) {
  const {input,asOfMs,fills,clearinghouse:c}=args;
  if(!Number.isSafeInteger(asOfMs)||asOfMs<0)throw new Error('invalid evidence time');
  const fill=fillMetrics(fills,c,asOfMs),holdouts=temporalHoldouts(input,asOfMs,args.holdoutDays);
  const leverage=measureLeverage(args.leverageSamples??[],asOfMs),reasons=[...fill.reasons];
  if(!leverage)reasons.push('HISTORICAL_AVERAGE_LEVERAGE_UNMEASURED');
  else reasons.push('LEVERAGE_ONLY_MEASURED_OVER_RECORDED_SAMPLE_INTERVAL');
  const validStates=validClearinghouse(c)&&c.asOfMs<=asOfMs&&asOfMs-c.asOfMs<=300_000;
  const gross=c.positions.reduce((n,p)=>n+Math.abs(p.signedNotionalUsd),0);
  const positions=validStates?c.positions.map(p=>({market:p.coin,signedNotionalUsd:p.signedNotionalUsd,
    leverage:p.configuredLeverage,liquidationDistance:p.liquidationDistance})):[];
  const completeHoldouts=holdouts.filter(h=>h.usable);
  const meanOf=(key:'sharpe'|'sortino')=>completeHoldouts.length===2&&completeHoldouts.every(h=>h.evaluation![key]!==null)
    ?completeHoldouts.reduce((n,h)=>n+h.evaluation![key]!,0)/2:null;
  if(completeHoldouts.length!==2)reasons.push('INSUFFICIENT_FIXED_TEMPORAL_HOLDOUT_COVERAGE');
  const metricPatch:MetricPatch={makerShare:fill.makerShare,timeInMarket:fill.timeInMarket,
    medianHoldMinutes:fill.medianHoldHours===null?null:fill.medianHoldHours*60,
    averageLeverage:leverage?.average??null,oosWindows:completeHoldouts.length,
    oosSharpe:meanOf('sharpe'),oosSortino:meanOf('sortino'),
    oosMaxDrawdown:completeHoldouts.length===2?Math.max(...completeHoldouts.map(h=>h.evaluation!.maxDrawdown!)):null,
    crossWindowStability:completeHoldouts.length===2?completeHoldouts.filter(h=>(h.evaluation!.periodReturn??-1)>0).length/2:null,
    survivorshipQuality:'CURRENT_SNAPSHOT',executionCoverage:null,executionFit:null,
    concentration:validStates&&gross>0?Math.max(...c.positions.map(p=>Math.abs(p.signedNotionalUsd)))/gross:null,
    liquidationDistance:validStates&&c.positions.length>0&&c.positions.every(p=>p.liquidationDistance!==null)
      ?Math.min(...c.positions.map(p=>p.liquidationDistance!)):null,btcBeta:null};
  return {address:input.address.toLowerCase(),scorePatch:{makerShare:fill.makerShare,timeInMarket:fill.timeInMarket,
    medianHoldHours:fill.medianHoldHours,avgLeverage:leverage?.average??null},metricPatch,positions,
    patterns:{increasesAfterLoss:null,repeatedRoundTrips:null,observedFills:fill.observedFills},holdouts,
    provenance:{schema:'measured-review-evidence.v1',asOfMs,fillWindow:{startMs:fills.startMs,endMs:fills.endMs,
      complete:fill.complete,pages:fills.pages,ageAtFrameMs:asOfMs-fills.endMs,closedEpisodes:fill.closedEpisodes,
      excludedCarryIn:fill.excludedCarryIn,openEpisodes:fill.openEpisodes},clearinghouse:{asOfMs:c.asOfMs,
      complete:validStates,rawSha256:c.rawSha256,instantaneousGrossLeverage:validStates&&c.accountValueUsd>0?gross/c.accountValueUsd:null},
      leverage,holdoutMethod:'FIXED_ADJACENT_WINDOWS; SCORE_DEPOSIT_ADJUSTED_INTERVALS; POSITIVE_WINDOW_FRACTION_STABILITY',
      survivorship:'CURRENT_SNAPSHOT',selectionBias:'Cohort discovered at the present snapshot; not prospective strategy OOS.'},
    reasons:[...new Set([...reasons,'EXECUTION_REPLAY_ASSESSMENT_REQUIRED'])]};
}

/** Same-direction overlap of each complete current book's normalized gross weights. */
export function currentExposureOverlap(a:ClearinghouseEvidence,b:ClearinghouseEvidence):number|null {
  if(!validClearinghouse(a)||!validClearinghouse(b)||Math.abs(a.asOfMs-b.asOfMs)>120_000)return null;
  const weights=(c:ClearinghouseEvidence)=>{const m=new Map<string,number>();let total=0;
    for(const p of c.positions){if(!Number.isFinite(p.signedNotionalUsd))return null;
      const n=Math.abs(p.signedNotionalUsd);total+=n;const key=`${p.coin}:${Math.sign(p.signedNotionalUsd)}`;m.set(key,(m.get(key)??0)+n);}
    return {m,total};};
  const x=weights(a),y=weights(b);if(!x||!y||x.total===0||y.total===0)return null;
  return [...x.m].reduce((n,[k,v])=>n+Math.min(v/x.total,(y.m.get(k)??0)/y.total),0);
}

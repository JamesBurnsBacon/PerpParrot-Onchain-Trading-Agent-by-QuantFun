// Numeric observations, not strategy labels. No model calls or policy decisions.
import {computeIntervals} from '../score/returns';
import {DEFAULT_CONFIG} from '../score/config';
import type {ScoreInput} from '../score/types';
import type {HlFill} from './evidence';
import type {LivePosition} from '../../review/input.ts';
import type {Evidence} from '../../../shared/src/review-evidence.ts';

const HOUR=3_600_000,DAY=24*HOUR;
type Patterns=Evidence['finalists'][number]['patterns'];
const perp=(coin:string)=>!coin.startsWith('@')&&!coin.includes('/');
const close=(a:number,b:number)=>Math.abs(a-b)<=1e-8*Math.max(1,Math.abs(a),Math.abs(b));

/** Ratios over observable events only. Reconstruct weighted entry from an observed flat start;
 * carried positions and discontinuities have unknown cost. An add is adverse if fill price is
 * below long entry / above short entry. Round-trip ratio = fully observed episodes <=10 min /
 * fully observed closed episodes; frequent round trips alone are NOT wash-trading evidence. */
export function tradePatterns(fills:HlFill[],from:number,to:number):Patterns {
  const rows=[...new Map(fills.filter(f=>perp(f.coin)&&f.time>=from&&f.time<=to)
    .map(f=>[JSON.stringify([f.coin,f.time,f.oid,f.side,f.startPosition,f.sz,f.px]),f])).values()]
    .sort((a,b)=>a.time-b.time);
  const books=new Map<string,{size:number;entry:number|null;opened:number|null}>();
  let adds=0,lossAdds=0,closed=0,fast=0,breaks=0;
  for(const f of rows) {
    const before=Number(f.startPosition),size=Number(f.sz),px=Number(f.px);
    if(!Number.isFinite(before)||!(size>0)||!Number.isFinite(size)||!(px>0)||!Number.isFinite(px)||!['A','B'].includes(f.side)) {
      books.delete(f.coin);continue;
    }
    const delta=(f.side==='B'?1:-1)*size,after=before+delta;
    let book=books.get(f.coin);
    if(book&&!close(book.size,before))breaks++;
    if(!book||!close(book.size,before))book={size:before,entry:null,opened:null};
    if(close(before,0))book={size:0,entry:px,opened:f.time};
    else if(Math.sign(delta)===Math.sign(before)) {
      if(book.entry!==null) {
        adds++;if((px-book.entry)*Math.sign(before)<0)lossAdds++;
        book.entry=(Math.abs(before)*book.entry+size*px)/(Math.abs(before)+size);
      }
    } else if(close(after,0)||Math.sign(after)!==Math.sign(before)) {
      if(book.opened!==null){closed++;if(f.time-book.opened<=10*60_000)fast++;}
      book={size:after,entry:close(after,0)?null:px,opened:close(after,0)?null:f.time};
    }
    book.size=close(after,0)?0:after;books.set(f.coin,book);
  }
  return {observedFills:rows.length,increasesAfterLoss:adds?lossAdds/adds:null,repeatedRoundTrips:closed?fast/closed:null,costBasisAdds:adds,closedEpisodes:closed,continuityBreaks:breaks};
}

export type BtcCandle={t:number;T:number;c:string};
/** Daily, matched timestamp beta = covariance(account returns, BTC returns) / BTC variance.
 * Account returns use Score's inferred-flow adjustment. Only completed UTC days, >=14 paired
 * daily intervals, fresh endpoints (<=2h before UTC midnight), and no future BTC close. */
export function bitcoinBeta(input:ScoreInput,candles:BtcCandle[],now:number):{value:number|null;pairs:number} {
  const pnl=new Map(input.month?.pnlHistory??[]);
  const byDay=new Map<number,{ts:number;accountValue:number;pnl:number}>();
  for(const [ts,accountValue] of input.month?.accountValueHistory??[]) {
    const day=Math.floor(ts/DAY),end=(day+1)*DAY;
    if(ts<now-30*DAY||end>now||end-ts>2*HOUR||!Number.isFinite(accountValue)||!Number.isFinite(pnl.get(ts)))continue;
    if(ts>(byDay.get(day)?.ts??0))byDay.set(day,{ts,accountValue,pnl:pnl.get(ts)!});
  }
  const points=[...byDay.values()].sort((a,b)=>a.ts-b.ts);
  const marks=candles.filter(c=>c.T<=now&&Number.isFinite(c.T)&&Number(c.c)>0&&Number.isFinite(Number(c.c))).sort((a,b)=>a.T-b.T);
  const price=(t:number)=>{const c=marks.findLast(c=>c.T<=t);return c&&t-c.T<=HOUR?Number(c.c):null;};
  const pairs:{x:number;y:number}[]=[];
  for(const i of computeIntervals(points,DEFAULT_CONFIG.dustEquityFraction).intervals) {
    const a=price(i.start),b=price(i.end);
    if(!i.used||i.dt<22/24||i.dt>26/24||!Number.isFinite(i.r)||i.r<=-1||a===null||b===null)continue;
    pairs.push({x:b/a-1,y:i.r});
  }
  if(pairs.length<14)return {value:null,pairs:pairs.length};
  const mx=pairs.reduce((s,p)=>s+p.x,0)/pairs.length,my=pairs.reduce((s,p)=>s+p.y,0)/pairs.length;
  const variance=pairs.reduce((s,p)=>s+(p.x-mx)**2,0);
  const beta=variance>1e-12?pairs.reduce((s,p)=>s+(p.x-mx)*(p.y-my),0)/variance:NaN;
  return {value:Number.isFinite(beta)?beta:null,pairs:pairs.length};
}

/** All observed positions before the top-12 details cap. Unknown HIP-3 stays other.
 * These are current exposures, not asset-specific profit or inferred historical strategies. */
export function exposureByClass(positions:LivePosition[]) {
  const result={crypto:{longUsd:0,shortUsd:0},gold:{longUsd:0,shortUsd:0},oil:{longUsd:0,shortUsd:0},other:{longUsd:0,shortUsd:0}};
  for(const p of positions) {
    const kind=['PAXG','xyz:GOLD'].includes(p.market)?'gold':['xyz:CL','xyz:BRENTOIL'].includes(p.market)?'oil':p.market.includes(':')?'other':'crypto';
    result[kind].longUsd+=Math.max(0,p.signedNotionalUsd);result[kind].shortUsd+=Math.max(0,-p.signedNotionalUsd);
  }
  for(const e of Object.values(result)) {e.longUsd=Math.round(e.longUsd*100)/100;e.shortUsd=Math.round(e.shortUsd*100)/100;}
  return result;
}

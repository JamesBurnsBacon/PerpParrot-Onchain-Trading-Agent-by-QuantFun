import type {ScoreFrame,LivePosition} from '../../packages/backend/review/input.ts';
import type {ScoreInput} from '../../packages/backend/src/score/types';
import {fixture} from './review-fixture.ts';
/** Score-shaped review input without running Score: three finalists, the third with a 10-point curve. */
export const DAY=86_400_000,NOW=1_791_291_000_000;
export const address=(n:number)=>'0x'+n.toString(16).padStart(40,'0');
// A month window of `points` PnL points ending at NOW (16 h apart, like Hyperliquid's month window).
const input=(n:number,points:number):ScoreInput=>({address:address(n).toUpperCase().replace('0X','0x'),kind:'trader',accountValue:50_000,closed:false,tradeCount:20,allTime:null,history:null,
  month:{accountValueHistory:[],pnlHistory:Array.from({length:points},(_,i)=>[NOW-(points-1-i)*DAY*2/3,1000+i*12.345] as const)}});
const metrics=(n:number)=>({historyDays:120+n,maxDrawdown:0.2,pnlConsistency:0.7,averageLeverage:null,timeInMarket:null,makerShare:null,medianHoldMinutes:null,isSharpe:1.5,isSortino:null,isCalmar:2,lookbackDays:90,scoreFlags:['no-downside'],cloneCount:n===0?1:0,oosWindows:0 as const,oosSharpe:null,oosSortino:null,oosMaxDrawdown:null,crossWindowStability:null});
export function setup(curvePoints=[45,45,10]) {
  const score:ScoreFrame={candidates:curvePoints.map((_,i)=>({candidate:i,kind:'TRADER' as const,clones:i===0?[address(99).toUpperCase().replace('0X','0x')]:[],metrics:metrics(i)})),
    addresses:curvePoints.map((_,i)=>address(i+1)),
    pairs:[{a:0,b:1,correlation:0.42,linkedSource:false},{a:0,b:2,correlation:0.1,linkedSource:false},{a:1,b:2,correlation:null,linkedSource:true}],skipped:[]};
  const inputs=curvePoints.map((points,i)=>input(i+1,points));
  const positions=new Map<string,LivePosition[]>(curvePoints.map((_,i)=>[address(i+1),[{market:'BTC',signedNotionalUsd:-1200.5,leverage:3,liquidationDistance:0.3}]]));
  return {score,inputs,positions,policy:fixture().configuration.policy,asOfMs:NOW,ttlMs:600_000};
}

import {expect,test} from 'bun:test';
import {tradePatterns,bitcoinBeta,exposureByClass} from '../src/pipeline/path-evidence';
import type {HlFill} from '../src/pipeline/evidence';
import type {ScoreInput} from '../src/score/types';
const DAY=86_400_000,HOUR=3_600_000;
const fill=(time:number,before:number,size:number,px:number,side:'B'|'A'='B',coin='BTC'):HlFill=>({time,startPosition:String(before),sz:String(size),px:String(px),side,coin,oid:time,crossed:true});
test('long/short losing adds use reconstructed cost; closes, flips and duplicates do not count as adds',()=>{
  const rows=[fill(1,0,1,100),fill(2,1,1,90),fill(3,2,1,110),fill(4,3,4,90,'A'),fill(5,-1,1,100,'A'),fill(6,-2,2,80)];
  const p=tradePatterns([...rows,rows[1]!],0,10);
  expect(p.observedFills).toBe(6);expect(p.costBasisAdds).toBe(3);expect(p.increasesAfterLoss).toBeCloseTo(2/3);
  expect(p.closedEpisodes).toBe(2);expect(p.repeatedRoundTrips).toBe(1);
});
test('carried-in or discontinuous cost basis stays unknown; spot and future fills excluded',()=>{
  const p=tradePatterns([fill(1,3,1,90),fill(2,0,1,100),fill(3,9,1,80),fill(4,0,1,1,'B','@1'),fill(11,10,1,70)],0,10);
  expect(p.increasesAfterLoss).toBeNull();expect(p.repeatedRoundTrips).toBeNull();expect(p.continuityBreaks).toBe(2);
  expect(tradePatterns([],0,10).observedFills).toBe(0);
  expect(tradePatterns([],0,10).increasesAfterLoss).toBeNull();
});
test('known return beta is two even with deposits; sparse or flat benchmark remains unknown',()=>{
  let equity=1000,pnl=0,btc=100;
  const points:{t:number;equity:number;pnl:number;btc:number}[]=[];
  for(let i=0;i<30;i++) {
    const ret=i%3===0?0.01:i%3===1?-0.02:0.015,deposit=i>0&&i%5===0?500:0;
    if(i){const dp=(equity+deposit)*2*ret;pnl+=dp;equity+=deposit+dp;btc*=1+ret;}
    points.push({t:(i+1)*DAY-HOUR/2,equity,pnl,btc});
  }
  const input={month:{accountValueHistory:points.map(p=>[p.t,p.equity]),pnlHistory:points.map(p=>[p.t,p.pnl])}} as ScoreInput;
  const candles=points.map(p=>({t:p.t-HOUR,T:p.t-1,c:String(p.btc)}));
  expect(bitcoinBeta(input,candles,30*DAY).value).toBeCloseTo(2,8);
  expect(bitcoinBeta(input,candles.slice(0,8),30*DAY).value).toBeNull();
  expect(bitcoinBeta(input,candles.map(c=>({...c,c:'100'})),30*DAY).value).toBeNull();
  expect(bitcoinBeta(input,candles.map(c=>({...c,T:c.T+HOUR})),30*DAY).value).toBeNull();
  expect(bitcoinBeta({...input,month:{...input.month!,pnlHistory:[]}},candles,30*DAY).value).toBeNull();
});
test('commodity totals include positions beyond the detail cap; unknown HIP-3 is other',()=>{
  const ps=Array.from({length:13},(_,i)=>({market:`COIN${i}`,signedNotionalUsd:100,leverage:null,liquidationDistance:null}));
  ps.push({market:'xyz:GOLD',signedNotionalUsd:10,leverage:null,liquidationDistance:null},
    {market:'xyz:CL',signedNotionalUsd:-20,leverage:null,liquidationDistance:null},
    {market:'xyz:UNKNOWN',signedNotionalUsd:30,leverage:null,liquidationDistance:null});
  const e=exposureByClass(ps);expect(e.crypto.longUsd).toBe(1300);expect(e.gold.longUsd).toBe(10);
  expect(e.oil.shortUsd).toBe(20);expect(e.other.longUsd).toBe(30);
});

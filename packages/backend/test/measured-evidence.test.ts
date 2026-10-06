import {describe,expect,test} from 'bun:test';
import {measureAccountEvidence,temporalHoldouts,currentExposureOverlap,fillIdentity,type MeasureAccountArgs,type NormalizedFill,type ClearinghouseEvidence} from '../review/measured-evidence';
import type {ScoreInput} from '../src/score/types';
import {validateEvidence} from '../../shared/src/review-evidence';

const DAY=86_400_000,HOUR=3_600_000,NOW=1_791_300_000_000,HASH='a'.repeat(64),START=NOW-30*DAY;
function input():ScoreInput{
  const accountValueHistory:[number,number][]=[],pnlHistory:[number,number][]=[];
  let pnl=0;
  for(let i=0;i<=90;i++){pnl+=i%4===0?-50:100;const time=NOW-(90-i)*DAY;accountValueHistory.push([time,10000+pnl]);pnlHistory.push([time,pnl]);}
  return {address:'0x'+'a'.repeat(40),kind:'trader',accountValue:accountValueHistory.at(-1)![1],closed:false,
    month:{accountValueHistory:accountValueHistory.slice(-31),pnlHistory:pnlHistory.slice(-31)},
    allTime:{accountValueHistory,pnlHistory},history:null,tradeCount:100};
}
function fill(time:number,start:number,size:number,side:'B'|'A',tid:number,maker=true):NormalizedFill{
  return {coin:'BTC',time,sz:String(size),px:'100',startPosition:String(start),side,crossed:!maker,tid};
}
function args(rows:NormalizedFill[]=[],position=0):MeasureAccountArgs{
  return {input:input(),asOfMs:NOW,fills:{rows,startMs:START,endMs:NOW,complete:true,
    pages:[{requestStartMs:START,requestEndMs:NOW,rawSha256:HASH,count:rows.length}]},
    clearinghouse:{asOfMs:NOW,complete:true,accountValueUsd:10000,rawSha256:[HASH],positions:position===0?[]:
      [{coin:'BTC',size:position,signedNotionalUsd:position*100,configuredLeverage:5,liquidationDistance:0.4}]}};
}

describe('measured real-account review evidence',()=>{
  test('uses maker notional and full flat-to-flat holding episodes, preserving open exclusions',()=>{
    const a=args([fill(START+HOUR,0,2,'B',1),fill(START+3*HOUR,2,1,'A',2,false),fill(START+5*HOUR,1,1,'A',3,false),fill(NOW-HOUR,0,1,'B',4)],1);
    const r=measureAccountEvidence(a);
    expect(r.scorePatch.makerShare).toBeCloseTo(3/5);
    expect(r.scorePatch.medianHoldHours).toBe(4);
    expect(r.scorePatch.timeInMarket).toBeCloseTo(5/720);
    expect(r.provenance.fillWindow.closedEpisodes).toBe(1);
    expect(r.provenance.fillWindow.openEpisodes).toBe(1);
    expect(r.metricPatch.averageLeverage).toBeNull();
    expect(r.provenance.clearinghouse.instantaneousGrossLeverage).toBe(0.01);
  });
  test('incomplete pagination does not promote partial fills into full-window measurements',()=>{
    const a=args([fill(START,0,1,'B',1),fill(START+5*HOUR,1,1,'A',2)]);a.fills.complete=false;
    const r=measureAccountEvidence(a);
    expect(r.scorePatch).toEqual({makerShare:null,timeInMarket:null,medianHoldHours:null,avgLeverage:null});
    expect(r.reasons).toContain('FILL_PAGINATION_INCOMPLETE');
  });
  test('excludes carry-in holding duration while counting its observed active time',()=>{
    const a=args([fill(START+HOUR,1,1,'A',1),fill(START+2*HOUR,0,1,'B',2),fill(START+8*HOUR,1,1,'A',3)]);
    const r=measureAccountEvidence(a);
    expect(r.scorePatch.medianHoldHours).toBe(6);
    expect(r.scorePatch.timeInMarket).toBeCloseTo(7/720);
    expect(r.provenance.fillWindow.excludedCarryIn).toBe(1);
  });
  test('handles close and reversal as two episodes; never uses current configured leverage as an average',()=>{
    const a=args([fill(START+HOUR,0,1,'B',1),fill(START+3*HOUR,1,2,'A',2),fill(START+7*HOUR,-1,1,'B',3)]);
    const r=measureAccountEvidence(a);
    expect(r.scorePatch.medianHoldHours).toBe(3);
    expect(r.provenance.fillWindow.closedEpisodes).toBe(2);
    expect(r.metricPatch.averageLeverage).toBeNull();
  });
  test('deduplicates pagination overlap by fill ID and reconstructs same-time order from positions',()=>{
    const first=fill(START+HOUR,0,1,'B',100),second=fill(START+HOUR,1,1,'B',1);
    const r=measureAccountEvidence(args([second,first,first,fill(START+5*HOUR,2,2,'A',2)]));
    expect(r.patterns.observedFills).toBe(3);
    expect(r.scorePatch.medianHoldHours).toBe(4);
  });
  test('same-timestamp cycles and inconsistent terminal state remain unknown',()=>{
    const ambiguous=measureAccountEvidence(args([fill(START,0,1,'B',1),fill(START,1,1,'A',2)]));
    expect(ambiguous.scorePatch.medianHoldHours).toBeNull();
    expect(ambiguous.reasons).toContain('POSITION_PATH_AMBIGUOUS:BTC');
    const mismatch=measureAccountEvidence(args([fill(START,0,1,'B',1)]));
    expect(mismatch.scorePatch.timeInMarket).toBeNull();
    expect(mismatch.reasons).toContain('TERMINAL_POSITION_MISMATCH:BTC');
  });
  test('out-of-window fills, page gaps and conflicting duplicate evidence invalidate metrics',()=>{
    const a=args([fill(NOW+1,0,1,'B',1)]);
    expect(measureAccountEvidence(a).scorePatch.makerShare).toBeNull();
    const b=args();b.fills.pages[0]!.requestStartMs=START+DAY;
    expect(measureAccountEvidence(b).reasons).toContain('FILL_PAGINATION_INCOMPLETE');
    const c=args([fill(START,0,1,'B',1),fill(START,0,2,'B',1)]);
    expect(measureAccountEvidence(c).reasons).toContain('CONFLICTING_DUPLICATE_FILL');
  });
  test('fixed holdout calculations adjust deposits through the production return helper',()=>{
    const a=input();
    for(const series of [a.month!,a.allTime!])for(let i=0;i<series.accountValueHistory.length;i++){
      const ts=series.accountValueHistory[i]![0];series.accountValueHistory[i]=[ts,ts>=NOW-7*DAY?20000:10000];series.pnlHistory[i]=[ts,0];
    }
    const h=temporalHoldouts(a,NOW);
    expect(h[1]!.evaluation!.periodReturn).toBe(0);
    expect(h[1]!.evaluation!.maxDrawdown).toBe(0);
    expect(h[1]!.evaluation!.sharpe).toBeNull();
    expect(h[1]!.scope).toBe('RETROSPECTIVE_CURRENT_COHORT_TEMPORAL_HOLDOUT');
  });
  test('evaluation returns cannot change earlier training metrics and future points are excluded',()=>{
    const a=input(),before=temporalHoldouts(a,NOW),b=structuredClone(a);
    for(const w of [b.month!,b.allTime!])for(let i=0;i<w.pnlHistory.length;i++)if(w.pnlHistory[i]![0]>=NOW-28*DAY){w.pnlHistory[i]=[w.pnlHistory[i]![0],w.pnlHistory[i]![1]+100];w.accountValueHistory[i]=[w.accountValueHistory[i]![0],w.accountValueHistory[i]![1]+100];}
    const after=temporalHoldouts(b,NOW);
    expect(after[0]!.training).toEqual(before[0]!.training);
    for(const w of [a.month!,a.allTime!]){w.accountValueHistory.push([NOW+DAY,1e12]);w.pnlHistory.push([NOW+DAY,1e12]);}
    expect(temporalHoldouts(a,NOW)).toEqual(before);
    expect(before.every(h=>h.training!.endMs<h.plannedStartMs&&h.evaluation!.startMs>=h.plannedStartMs)).toBe(true);
  });
  test('historical leverage is a scoped measured interval, requiring >=10 min and retained raw evidence',()=>{
    const a=args();a.leverageSamples=[{atMs:NOW-600000,equityUsd:10000,grossNotionalUsd:20000,rawSha256:[HASH]},
      {atMs:NOW,equityUsd:10000,grossNotionalUsd:40000,rawSha256:[HASH]}];
    const r=measureAccountEvidence(a);expect(r.scorePatch.avgLeverage).toBe(3);
    expect(r.provenance.leverage!.scope).toBe('OBSERVED_SAMPLE_INTERVAL_ONLY');
    a.leverageSamples[0]!.atMs=NOW-599999;expect(measureAccountEvidence(a).scorePatch.avgLeverage).toBeNull();
  });
  test('overlap compares complete signed current books, ignoring opposite directions',()=>{
    const state=(size:number):ClearinghouseEvidence=>args([],size).clearinghouse;
    expect(currentExposureOverlap(state(1),state(2))).toBe(1);
    expect(currentExposureOverlap(state(1),state(-2))).toBe(0);
    expect(currentExposureOverlap(state(0),state(1))).toBeNull();
    const b=state(1);b.complete=false;expect(currentExposureOverlap(state(1),b)).toBeNull();
  });
  test('excludes spot fills from perp maker notional and position paths',()=>{
    const a=args([fill(START,0,1,'B',1),fill(START+HOUR,1,1,'A',2),
      {...fill(START,0,100000,'B',3,false),coin:'@107'},
      {...fill(START,0,100000,'B',4,false),coin:'BTC/USDC'}]);
    const r=measureAccountEvidence(a);expect(r.scorePatch.makerShare).toBe(1);
    expect(r.patterns.observedFills).toBe(2);expect(r.scorePatch.medianHoldHours).toBe(1);
  });
  test('full pages require overlap-boundary metadata and a terminal short page',()=>{
    const a=args([fill(START,0,1,'B',1),fill(START+HOUR,1,1,'A',2)]);
    a.fills.pages[0]!.count=2000;
    expect(measureAccountEvidence(a).reasons).toContain('FILL_PAGINATION_INCOMPLETE');
    a.fills.pages[0]!.lastFillMs=START+HOUR;
    a.fills.pages.push({requestStartMs:START+HOUR,requestEndMs:NOW,rawSha256:HASH,count:1});
    expect(measureAccountEvidence(a).scorePatch.medianHoldHours).toBe(1);
    a.fills.pages[1]!.requestStartMs+=1;
    expect(measureAccountEvidence(a).reasons).toContain('FILL_PAGINATION_INCOMPLETE');
  });
  test('freshness preserves actual collection timestamps and rejects stale fill endpoints',()=>{
    const a=args([fill(START,0,1,'B',1),fill(START+HOUR,1,1,'A',2)]);
    a.asOfMs=NOW+60_000;a.clearinghouse.asOfMs=NOW+30_000;
    expect(measureAccountEvidence(a).provenance.fillWindow.ageAtFrameMs).toBe(60_000);
    expect(measureAccountEvidence(a).scorePatch.medianHoldHours).toBe(1);
    a.asOfMs=NOW+300_001;expect(measureAccountEvidence(a).scorePatch.medianHoldHours).toBeNull();
  });
  test('invalid or duplicate current positions cannot certify holding periods, overlap, or exposure metrics',()=>{
    for(const corrupt of [
      (c:ClearinghouseEvidence)=>{c.positions.push({...c.positions[0]!});},
      (c:ClearinghouseEvidence)=>{c.positions[0]!.signedNotionalUsd=NaN;},
      (c:ClearinghouseEvidence)=>{c.positions[0]!.configuredLeverage=Infinity;},
      (c:ClearinghouseEvidence)=>{c.accountValueUsd=NaN;},
      (c:ClearinghouseEvidence)=>{c.positions[0]!.liquidationDistance=-1;},
    ]){
      const a=args([fill(START,0,1,'B',1),fill(START+HOUR,1,1,'A',2),fill(NOW-HOUR,0,1,'B',3)],1);
      corrupt(a.clearinghouse);const r=measureAccountEvidence(a);
      expect(r.scorePatch.medianHoldHours).toBeNull();expect(r.scorePatch.timeInMarket).toBeNull();
      expect(r.provenance.clearinghouse.complete).toBe(false);expect(r.positions).toEqual([]);
      expect(currentExposureOverlap(a.clearinghouse,args([],1).clearinghouse)).toBeNull();
    }
  });
  test('stale or overflowing sampled leverage cannot become current average leverage',()=>{
    const a=args();a.leverageSamples=[{atMs:NOW-900001,equityUsd:10000,grossNotionalUsd:20000,rawSha256:[HASH]},
      {atMs:NOW-300001,equityUsd:10000,grossNotionalUsd:40000,rawSha256:[HASH]}];
    expect(measureAccountEvidence(a).metricPatch.averageLeverage).toBeNull();
    for(const s of a.leverageSamples){s.atMs+=300001;s.equityUsd=Number.MIN_VALUE;s.grossNotionalUsd=Number.MAX_VALUE;}
    expect(measureAccountEvidence(a).metricPatch.averageLeverage).toBeNull();
  });
  test('execution identity tolerates reused tids across distinct times/orders while detecting conflicting copies',()=>{
    const first={...fill(START,0,1,'B',0),oid:1},second={...fill(START+HOUR,1,1,'A',0),oid:2};
    expect(fillIdentity(first)).not.toBe(fillIdentity(second));
    expect(fillIdentity(first)).not.toBe(fillIdentity({...first,oid:3}));
    expect(fillIdentity(first)).toBe(fillIdentity({...first,sz:'2'}));
    const r=measureAccountEvidence(args([first,second]));
    expect(r.scorePatch.medianHoldHours).toBe(1);expect(r.patterns.observedFills).toBe(2);
    expect(measureAccountEvidence(args([first,{...first,sz:'2'}])).reasons).toContain('CONFLICTING_DUPLICATE_FILL');
  });
  test('large retained partial histories preserve their exact count without inventing a capped model value',()=>{
    for(const count of [10000,11595]){
      const rows=Array.from({length:count},(_,i)=>fill(START+i,i%2,1,i%2?'A':'B',i));
      // One pagination duplicate and one spot execution are not extra perp fills.
      const a=args([...rows,rows[0]!,{...rows[0]!,coin:'@107'}],count%2);
      a.fills.complete=false;a.fills.missingReasons=['UPSTREAM_10000_FILL_RETENTION'];
      const r=measureAccountEvidence(a);
      expect(r.provenance.fillWindow.observedPerpFills).toBe(count);
      expect(r.provenance.fillWindow.complete).toBe(false);
      expect(r.patterns.observedFills).toBe(count<=10000?count:null);
      expect(r.scorePatch.makerShare).toBeNull();expect(r.scorePatch.medianHoldHours).toBeNull();
      expect(r.reasons.includes('OBSERVED_FILL_COUNT_EXCEEDS_SCHEMA_LIMIT')).toBe(count>10000);
      const evidence={asOfMs:NOW,finalists:[{candidate:0,kind:'TRADER',historyDays:90,
        timeInMarket:r.metricPatch.timeInMarket,medianHoldMinutes:r.metricPatch.medianHoldMinutes,
        makerShare:r.metricPatch.makerShare,maxDrawdown:r.metricPatch.oosMaxDrawdown,
        equityCurve:a.input.month!.pnlHistory.slice(-26).map(([atMs,pnlUsd])=>({atMs,pnlUsd})),
        positions:[],patterns:r.patterns}],pairs:[]};
      expect(()=>validateEvidence(evidence)).not.toThrow();
      if(count>10000){
        expect(r.patterns.observedFills).not.toBe(10000);
        expect(()=>validateEvidence({...evidence,finalists:[{...evidence.finalists[0],patterns:{...r.patterns,observedFills:count}}]})).toThrow();
      }
    }
  });
});

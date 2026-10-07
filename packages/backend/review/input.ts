import {validate} from '../../shared/src/validate.ts';
import {validateEvidence,byteLength,type Evidence} from '../../shared/src/review-evidence.ts';
import {bindCommitteeEvidence,type CommitteeEvidence} from '../../shared/src/committee-evidence.ts';
import {policyCommitment,snapshotCommitment} from '../../shared/src/commitments.ts';
import {CONTRACT_VERSION,type Frame,type Policy} from '../../shared/src/contracts.ts';
import type {ScoreInput} from '../src/score/types';
import type {toFrameCandidates} from '../src/score/frame';
/** Review input from Score's finalists (README §4.6): a frame 1.1.0 that passes the schema and the input
 * commitments, plus the anonymous evidence models read. Fields no module supplies yet are null (unknown,
 * never safe); the review's compile step rejects candidates without OOS and execution evidence. */
export type ScoreFrame=ReturnType<typeof toFrameCandidates>;
export type LivePosition=Evidence['finalists'][number]['positions'][number];
export type Skipped={address:string;reason:'unknown-history'|'short-curve'};
export interface ReviewInput {frame:Frame;evidence:Evidence;committee:CommitteeEvidence;addresses:Map<number,string>;skipped:Skipped[]}
const MIN_CURVE=26,MAX_CURVE=48,MAX_POSITIONS=12,FINALIST_BYTES=4096;
const round=(value:number,digits:number)=>{const scale=10**digits;return Math.round(value*scale)/scale;};
/** Evenly spaced points including both ends (at most `max`). */
const thin=<T,>(points:T[],max:number):T[]=>points.length<=max?points:Array.from({length:max},(_,i)=>points[Math.round(i*(points.length-1)/(max-1))]);
/** The month window's PnL as the model's equity curve: points at or before asOfMs, cents. */
export function monthCurve(input:ScoreInput,asOfMs:number):{atMs:number;pnlUsd:number}[] {
  const points=(input.month?.pnlHistory??[]).filter(([ts])=>ts<=asOfMs).map(([atMs,pnl])=>({atMs,pnlUsd:round(pnl,2)}));
  return thin(points,MAX_CURVE);
}
/** Hyperliquid clearinghouseState positions (one state per dex) as evidence rows, largest first. */
export function positionsFromStates(states:{assetPositions:{position:{coin:string;szi:string;positionValue:string;leverage?:{value:number}|null;liquidationPx?:string|null}}[]}[]):LivePosition[] {
  const rows=states.flatMap(state=>state.assetPositions.map(({position})=>{
    const size=Number(position.szi),value=Number(position.positionValue);
    if(!Number.isFinite(size)||!Number.isFinite(value)||size===0)throw new Error(`invalid position ${position.coin}`);
    const mark=value/Math.abs(size),liquidation=position.liquidationPx==null?null:Number(position.liquidationPx);
    const distance=liquidation===null||!Number.isFinite(liquidation)||!(mark>0)?null:Math.min(1,Math.abs(mark-liquidation)/mark);
    return {market:position.coin,signedNotionalUsd:round(Math.sign(size)*value,2),leverage:position.leverage?.value??null,liquidationDistance:distance===null?null:round(distance,4)};
  }));
  return rows.sort((a,b)=>Math.abs(b.signedNotionalUsd)-Math.abs(a.signedNotionalUsd)||(a.market<b.market?-1:1));
}
/** Score finalists -> validated frame + evidence. Positions must be read for every kept finalist (by
 * lower-case address); a missing read is an error, never an empty book. */
export function buildReviewInput(args:{score:ScoreFrame;inputs:ScoreInput[];positions:ReadonlyMap<string,LivePosition[]>;policy:Policy;asOfMs:number;ttlMs:number}):ReviewInput {
  const {score,policy,asOfMs}=args;
  if(!Number.isSafeInteger(asOfMs)||!Number.isSafeInteger(args.ttlMs)||args.ttlMs<=0)throw new Error('invalid review clock');
  const inputs=new Map(args.inputs.map(input=>[input.address.toLowerCase(),input]));
  const skipped:Skipped[]=[];
  const kept:{from:number;address:string;curve:ReturnType<typeof monthCurve>;positions:LivePosition[]}[]=[];
  score.candidates.forEach((candidate,from)=>{
    const address=score.addresses[from]!.toLowerCase(),input=inputs.get(address);
    if(!input||candidate.candidate!==from)throw new Error(`review input: no Score input for finalist ${address}`);
    const curve=monthCurve(input,asOfMs);
    if(curve.length<MIN_CURVE){skipped.push({address,reason:'short-curve'});return;}
    const positions=args.positions.get(address);
    if(!positions)throw new Error(`review input: positions not read for ${address}`);
    kept.push({from,address,curve,positions:positions.slice(0,MAX_POSITIONS)});
  });
  if(!kept.length)throw new Error('review input: no reviewable finalists');
  const index=new Map(kept.map(({from},to)=>[from,to]));
  const candidates:Frame['candidates']=kept.map(({from},to)=>{
    const {kind,clones,metrics}=score.candidates[from]!;
    return {candidate:to,kind,clones:clones.map(address=>address.toLowerCase()),metrics:{...metrics,survivorshipQuality:'UNKNOWN',executionCoverage:null,executionFit:null,concentration:null,liquidationDistance:null,btcBeta:null}};
  });
  const pairs:Frame['pairs']=score.pairs.filter(p=>index.has(p.a)&&index.has(p.b)).map(p=>{
    const [a,b]=[index.get(p.a)!,index.get(p.b)!].sort((x,y)=>x-y);
    return {a:a!,b:b!,correlation:p.correlation,currentExposureOverlap:null,linkedSource:p.linkedSource};
  }).sort((x,y)=>x.a-y.a||x.b-y.b);
  const finalists:Evidence['finalists']=kept.map(({curve,positions},to)=>{
    const {kind,metrics}=candidates[to]!;
    const row={candidate:to,kind,historyDays:metrics.historyDays,timeInMarket:metrics.timeInMarket,medianHoldMinutes:metrics.medianHoldMinutes,makerShare:metrics.makerShare,maxDrawdown:metrics.maxDrawdown,equityCurve:curve,positions,patterns:{increasesAfterLoss:null,repeatedRoundTrips:null,observedFills:null}};
    // Committee evidence caps a finalist (metrics + curve + positions + patterns) at 4 KB: thin the
    // curve to its minimum first, then drop the smallest positions.
    const size=()=>byteLength({candidate:to,kind,metrics,equityCurve:row.equityCurve,positions:row.positions,patterns:row.patterns});
    for(let points=curve.length;size()>FINALIST_BYTES&&points>MIN_CURVE;)row.equityCurve=thin(curve,--points);
    while(size()>FINALIST_BYTES&&row.positions.length>0)row.positions=row.positions.slice(0,-1);
    return row;
  });
  const addresses=new Map(kept.map(({address},to)=>[to,address]));
  const frame:Frame={schemaVersion:CONTRACT_VERSION,snapshotHash:'',policyHash:policyCommitment(policy),asOfMs,expiresAtMs:asOfMs+args.ttlMs,candidates,pairs};
  frame.snapshotHash=snapshotCommitment(frame,addresses);
  validate('candidate-curation-frame',frame);
  const evidence=validateEvidence({asOfMs,finalists,pairs:pairs.map(({a,b,correlation,linkedSource})=>({a,b,correlation,linkedSource}))});
  return {frame,evidence,committee:bindCommitteeEvidence(frame,policy,addresses,evidence),addresses,skipped};
}

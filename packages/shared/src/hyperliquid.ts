import {z} from 'zod';
import {decimal,abs} from './decimal.ts';
import type {AccountState} from './mirror-state.ts';
const text=z.string().max(44).refine(value=>{try{decimal(value);return true;}catch{return false;}});
const summary=z.object({accountValue:text,totalNtlPos:text,totalMarginUsed:text,totalRawUsd:text});
const clearinghouse=z.object({time:z.number().int().nonnegative().safe(),marginSummary:summary,crossMarginSummary:summary,
  crossMaintenanceMarginUsed:text,withdrawable:text,
  assetPositions:z.array(z.object({type:z.literal('oneWay'),position:z.object({coin:z.string().regex(/^[A-Za-z0-9:_-]{1,64}$/),
    szi:text,positionValue:text,leverage:z.object({type:z.enum(['cross','isolated']),value:z.number().int().positive().max(100)}),
  })})).max(100),
});
function micros(value:string):bigint {const p=decimal(value);return p.n*1000000n/p.d;}
export function parseClearinghouseState(value:unknown,address:string,nowMs:number,maxAgeMs:number):AccountState {
  if(!/^0x[0-9a-f]{40}$/.test(address)||!Number.isSafeInteger(nowMs)||!Number.isSafeInteger(maxAgeMs)||maxAgeMs<=0||maxAgeMs>600000)throw new Error('invalid clearinghouse query');
  const state=clearinghouse.parse(value);
  if(state.time>nowMs||nowMs-state.time>maxAgeMs)throw new Error('stale clearinghouse state');
  const positions=state.assetPositions.map(({position})=>{
    const size=decimal(position.szi).n,value=micros(position.positionValue);
    if(value<0n||size===0n&&value!==0n)throw new Error('inconsistent position value');
    return {market:position.coin,notionalMicros:(size<0n?-value:value).toString()};
  }).sort((a,b)=>a.market<b.market?-1:a.market>b.market?1:0);
  if(new Set(positions.map(p=>p.market)).size!==positions.length)throw new Error('duplicate exchange position');
  const reported=micros(state.marginSummary.totalNtlPos),sum=positions.reduce((total,p)=>total+abs(BigInt(p.notionalMicros)),0n);
  if(reported<0n||abs(reported-sum)>BigInt(positions.length+1))throw new Error('incomplete clearinghouse exposure');
  return {address,observedAtMs:state.time,equityMicros:micros(state.marginSummary.accountValue).toString(),positions};
}

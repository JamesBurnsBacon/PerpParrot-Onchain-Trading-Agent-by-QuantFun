import {z} from 'zod';
import {buildMirrorPlan} from '../../cre-workflows/mirror/core.ts';
import type {MirrorInput} from '../../cre-workflows/mirror/core.ts';
import {commitment} from '../../shared/src/commitments.ts';
import {decimal,units,formatUnits,abs,ceilDiv,perpLimit} from '../../shared/src/decimal.ts';
import {sealExecutionPreview} from '../../shared/src/execution-preview.ts';
import type {ExecutionPreview} from '../../shared/src/execution-preview.ts';
const decimalText=z.string().max(44).refine(value=>{try{decimal(value);return true;}catch{return false;}});
const market=z.object({market:z.string().regex(/^[A-Za-z0-9:_-]{1,64}$/),asset:z.number().int().min(0).max(9999),
  szDecimals:z.number().int().min(0).max(6),markPx:decimalText,leverage:z.number().int().min(1).max(50),
  maxLeverage:z.number().int().min(1).max(50),crossAllowed:z.literal(true),collateralToken:z.literal(0),
}).strict();
export const executionContextSchema=z.object({accountMode:z.literal('STANDARD'),dex:z.literal(''),observedAtMs:z.number().int().nonnegative().safe(),
  positions:z.array(z.object({market:z.string(),signedSize:decimalText}).strict()).max(100),markets:z.array(market).min(1).max(100),
  openOrders:z.literal(0),marginReserveBps:z.number().int().min(2000).max(10000),feeBps:z.number().int().min(0).max(100),
  slippageBps:z.number().int().min(0).max(1000),maintenanceMarginMicros:z.string().regex(/^(0|[1-9][0-9]{0,23})$/),
}).strict();
export type ExecutionContext=z.infer<typeof executionContextSchema>;
/** Produces exchange-shaped IOC orders, never live authorization. Only standard
 * USDC core cross-margin is supported until HIP-3 collateral pools are modeled. */
export function compileExecutionPreview(input:MirrorInput,value:unknown):ExecutionPreview {
  const context=executionContextSchema.parse(value),result=buildMirrorPlan(input);
  if(result.status!=='READY')throw new Error('mirror evidence rejected');
  const plan=result.plan;
  if(context.marginReserveBps<Math.ceil(input.configuration.policy.cashBuffer*10000))throw new Error('execution reserve below frozen policy');
  if(context.observedAtMs>input.nowMs||input.nowMs-context.observedAtMs>input.maxStateAgeMs)throw new Error('stale execution context');
  const markets=new Map(context.markets.map(m=>[m.market,m])),sizes=new Map(context.positions.map(p=>[p.market,p.signedSize]));
  if(markets.size!==context.markets.length||sizes.size!==context.positions.length||new Set(context.markets.map(m=>m.asset)).size!==context.markets.length)throw new Error('duplicate execution identity');
  const actual=new Map(input.account.positions.map(p=>[p.market,BigInt(p.notionalMicros)]));
  for(const name of new Set([...actual.keys(),...sizes.keys()])) {
    const m=markets.get(name);if(!m)throw new Error('missing held-market metadata');
    const qty=units(sizes.get(name)??'0',m.szDecimals),p=decimal(m.markPx);
    if(p.n<=0n||m.leverage>m.maxLeverage||name.includes(':'))throw new Error('unsupported market or leverage');
    const observed=qty*p.n*1000000n/(10n**BigInt(m.szDecimals)*p.d);
    if(abs(observed-(actual.get(name)??0n))>1n)throw new Error('quantity/valuation mismatch');
  }
  const orders:ExecutionPreview['orders']=[],deferredReversals:string[]=[];
  const changes=new Map<string,bigint>();
  for(const delta of plan.deltas) {
    const m=markets.get(delta.market);if(!m||m.market.includes(':')||m.leverage>m.maxLeverage)throw new Error('unsupported execution market');
    const p=decimal(m.markPx);if(p.n<=0n)throw new Error('nonpositive execution mark');
    const current=units(sizes.get(m.market)??'0',m.szDecimals),scale=10n**BigInt(m.szDecimals),change=BigInt(delta.notionalMicros);
    let qty=abs(change)*scale*p.d/(1000000n*p.n),buy=change>0n,reduceOnly=delta.reduceOnly;
    const desired=BigInt(plan.targets.find(target=>target.market===m.market)?.notionalMicros??'0');
    if(current!==0n&&desired*current<=0n){qty=abs(current);reduceOnly=true;if(desired!==0n)deferredReversals.push(m.market);}
    else if(current!==0n&&change*current<0n) {
      reduceOnly=true;
      if(qty>abs(current)){qty=abs(current);deferredReversals.push(m.market);}
    }
    if(qty===0n)continue;
    const limitPx=perpLimit(m.markPx,m.szDecimals,context.slippageBps,buy),limit=decimal(limitPx);
    if(qty*p.n*1000000n<10000000n*scale*p.d||qty*limit.n*1000000n<10000000n*scale*limit.d)continue;
    orders.push({market:m.market,asset:m.asset,isBuy:buy,limitPx,size:formatUnits(qty,m.szDecimals),reduceOnly,tif:'Ioc',
      cloid:commitment('perpparrot:order-id:v1',{configurationHash:plan.configurationHash,runId:plan.runId,planHash:plan.planHash,market:m.market}).slice(0,34)});
    changes.set(m.market,buy?qty:-qty);
  }
  let worstInitial=0n,fees=0n,worstGross=0n;
  const equity=BigInt(input.account.equityMicros);
  for(const name of new Set([...actual.keys(),...changes.keys()])) {
    const m=markets.get(name)!;const current=units(sizes.get(name)??'0',m.szDecimals),projected=current+(changes.get(name)??0n);
    const order=orders.find(o=>o.market===name),mark=decimal(m.markPx),limit=decimal(order?.limitPx??m.markPx);
    const p=mark.n*limit.d>=limit.n*mark.d?mark:limit;
    const maximum=abs(current)>abs(projected)?abs(current):abs(projected);
    const exposure=ceilDiv(maximum*p.n*1000000n,10n**BigInt(m.szDecimals)*p.d);
    const allowed=input.markets.find(item=>item.market===name);if(!allowed||exposure>BigInt(allowed.maxAbsNotionalMicros))throw new Error('rounded execution market cap');
    worstGross+=exposure;worstInitial+=ceilDiv(exposure,BigInt(m.leverage));
    if(order)fees+=ceilDiv(abs(changes.get(name)!)*limit.n*1000000n*BigInt(context.feeBps),10n**BigInt(m.szDecimals)*limit.d*10000n);
  }
  const grossUnits=Math.floor(input.configuration.policy.maxGrossLeverage*1000000);
  if(worstGross*1000000n>equity*BigInt(grossUnits))throw new Error('rounded execution gross cap');
  const budget=equity*BigInt(10000-context.marginReserveBps)/10000n;
  if(worstInitial+fees>budget||BigInt(context.maintenanceMarginMicros)+fees>budget)throw new Error('insufficient margin reserve');
  const expiresAtMs=Math.min(plan.expiresAtMs,context.observedAtMs+input.maxStateAgeMs,input.nowMs+60000);
  if(expiresAtMs<=input.nowMs)throw new Error('execution evidence expired');
  return sealExecutionPreview({schemaVersion:'2.0.0',mode:'PREVIEW',economicAuthority:false,chainId:input.configuration.chainId,account:input.account.address,
    runId:plan.runId,configurationHash:plan.configurationHash,policyHash:input.configuration.policyHash,planHash:plan.planHash,
    executionEvidenceHash:commitment('perpparrot:execution-evidence:v1',context),createdAtMs:input.nowMs,expiresAtMs,orders,deferredReversals,
    worstInitialMarginMicros:worstInitial.toString(),feeReserveMicros:fees.toString()});
}

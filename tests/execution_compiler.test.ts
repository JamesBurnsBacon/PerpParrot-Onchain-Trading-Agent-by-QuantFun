import {test} from 'node:test';
import {commitment} from '../packages/shared/src/commitments.ts';
import assert from 'node:assert/strict';
import {fixture} from './support/mirror-fixture.ts';
import {compileExecutionPreview} from '../packages/executor/src/compiler.ts';
import type {ExecutionContext} from '../packages/executor/src/compiler.ts';
import {perpLimit,units,formatUnits,decimal} from '../packages/shared/src/decimal.ts';
import {validateExecutionPreview} from '../packages/shared/src/execution-preview.ts';
function context():ExecutionContext{return {accountMode:'STANDARD',dex:'',observedAtMs:2900,positions:[],markets:[{market:'BTC',asset:0,szDecimals:3,markPx:'100',leverage:2,maxLeverage:40,crossAllowed:true,collateralToken:0}],openOrders:0,marginReserveBps:2000,feeBps:5,slippageBps:50,maintenanceMarginMicros:'0'};}
test('exact decimal and perp tick rounding obey exchange examples',()=>{
  assert.equal(formatUnits(units('1.001',3),3),'1.001');assert.throws(()=>units('1.0001',3));
  assert.equal(perpLimit('1234.5',0,0,true),'1234.5');
  assert.throws(()=>perpLimit('1234.567',0,0,true),/tick/);
  assert.equal(perpLimit('123456',0,0,true),'123456');
  assert.equal(perpLimit('0.001234',0,50,true),'0.00124');
  assert.equal(perpLimit('0.001234',0,50,false),'0.001228');
});
test('preview emits exact IOC orders with no authority and reproducible bindings',()=>{
  const input=fixture(),report=compileExecutionPreview(input,context());
  assert.equal(report.mode,'PREVIEW');assert.equal(report.economicAuthority,false);
  assert.deepEqual(report.orders.map(({cloid,...order})=>order),[{market:'BTC',asset:0,isBuy:true,limitPx:'100.5',size:'6',reduceOnly:false,tif:'Ioc'}]);
  assert.deepEqual(compileExecutionPreview(input,context()),report);
  assert.deepEqual(validateExecutionPreview(report,input.nowMs),report);
  assert.equal(report.worstInitialMarginMicros,'301500000');
  assert.throws(()=>validateExecutionPreview(report,report.expiresAtMs));
});
test('sign reversals close reduce-only and defer reopening to a fresh report',()=>{
  const input=fixture();input.account.positions=[{market:'BTC',notionalMicros:'-100000000'}];
  const evidence=context();evidence.positions=[{market:'BTC',signedSize:'-1'}];
  const report=compileExecutionPreview(input,evidence);
  assert.equal(report.orders[0].size,'1');assert.equal(report.orders[0].reduceOnly,true);
  assert.deepEqual(report.deferredReversals,['BTC']);
});
test('unsupported pools, position valuation changes and margin exhaustion reject',()=>{
  const input=fixture(),evidence=context();
  evidence.marginReserveBps=8000;assert.throws(()=>compileExecutionPreview(input,evidence),/margin/);
  const position=context();position.positions=[{market:'BTC',signedSize:'1'}];assert.throws(()=>compileExecutionPreview(input,position),/valuation/);
  assert.throws(()=>compileExecutionPreview(input,{...context(),dex:'xyz'}));
  assert.throws(()=>compileExecutionPreview(input,{...context(),openOrders:1}));
  const stale=context();stale.observedAtMs=0;assert.throws(()=>compileExecutionPreview(input,stale),/stale/);
});
test('rounded subminimum legs are skipped rather than inventing larger orders',()=>{
  const input=fixture();input.account.positions=[{market:'BTC',notionalMicros:'660000000'}];
  const evidence=context();evidence.positions=[{market:'BTC',signedSize:'6.6'}];evidence.markets[0].szDecimals=0;
  assert.throws(()=>compileExecutionPreview(input,evidence),/precision/);
});
test('full closes use exact exchange quantity despite micro-USD valuation truncation',()=>{
 const input=fixture();input.snapshot.sources.forEach(s=>s.positions=[]);input.checks.forEach(s=>s.positions=[]);
 const {snapshotHash:_,...snapshot}=input.snapshot;
 input.snapshot.snapshotHash=commitment('perpparrot:positions:v1',snapshot);
 input.account.positions=[{market:'BTC',notionalMicros:'12345678'}];
 const evidence=context();evidence.markets[0].markPx='123.4567891';evidence.positions=[{market:'BTC',signedSize:'0.1'}];
 const report=compileExecutionPreview(input,evidence);
 assert.equal(report.orders[0].size,'0.1');assert.equal(report.orders[0].reduceOnly,true);
});
test('perp rounding stays inside the approved slippage interval across magnitudes',()=>{
 let checked=0;
 for(const mark of ['0.0001','0.001234','0.01234','0.12345','1.2345','12.345','123.45','1234.5','12345','123456'])for(const decimals of [0,1,3,5])for(const buy of [false,true]){
  let price:string;try{price=perpLimit(mark,decimals,100,buy);}catch{continue;} // No legal tick is a safe rejection.
  checked++;const p=decimal(price),m=decimal(mark);
  assert.ok(buy?p.n*m.d>=m.n*p.d:p.n*m.d<=m.n*p.d);
  assert.ok(buy?p.n*m.d*10000n<=m.n*p.d*10100n:p.n*m.d*10000n>=m.n*p.d*9900n);
  const [whole,fraction='']=price.split('.');assert.ok(fraction.length<=6-decimals);
  if(fraction)assert.ok((whole+fraction).replace(/^0+/,'').length<=5);
 }
 assert.ok(checked>=40);
});

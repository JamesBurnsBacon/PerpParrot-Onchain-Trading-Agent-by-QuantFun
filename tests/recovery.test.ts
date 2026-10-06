import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {PGlite} from '@electric-sql/pglite';
import {fixture} from './support/mirror-fixture.ts';
import {compileExecutionPreview} from '../packages/executor/src/compiler.ts';
import {RecoverablePreviewExecutor} from '../packages/executor/src/recovery.ts';
import {SupabasePreviewStore} from '../packages/executor/src/supabase-store.ts';
import type {Rpc} from '../packages/executor/src/supabase-store.ts';
const context={accountMode:'STANDARD',dex:'',observedAtMs:2900,positions:[],markets:[{market:'BTC',asset:0,szDecimals:3,markPx:'100',leverage:2,maxLeverage:40,crossAllowed:true,collateralToken:0}],openOrders:0,marginReserveBps:2000,feeBps:5,slippageBps:50,maintenanceMarginMicros:'0'};
test('database-backed executor recovers ambiguous submission without duplicate simulation',async()=>{
 const db=new PGlite();await db.exec('create role anon; create role authenticated; create role service_role bypassrls;');await db.exec(readFileSync(new URL('../packages/backend/migrations/001_execution_state.sql',import.meta.url),'utf8'));
 const rpc:Rpc={async call(name,args){const keys=Object.keys(args),values=Object.values(args);const sql=`select ${name}(${keys.map((key,i)=>key+' => $'+(i+1)+(key==='p_receipt'?'::jsonb':'')).join(',')}) as value`;return (await db.query<{value:unknown}>(sql,values.map(v=>typeof v==='object'?JSON.stringify(v):v))).rows[0].value;}};
 try {
 const input=fixture(),report=compileExecutionPreview(input,context);let simulations=0,reconciliations=0;
 const receipt={mode:'PREVIEW',reportHash:report.reportHash,orders:report.orders.map(order=>({cloid:order.cloid,state:'FILLED',filledSize:order.size}))};
 const store=new SupabasePreviewStore(rpc),venue={async simulate(){simulations++;throw new Error('lost response after remote acceptance');},async reconcile(){reconciliations++;return receipt;}};
 const first=new RecoverablePreviewExecutor(store,venue);
 assert.equal(await first.execute(report,input,context,'0x'+'b'.repeat(40),input.nowMs),null);
 const restarted=new RecoverablePreviewExecutor(new SupabasePreviewStore(rpc),venue);
 assert.deepEqual(await restarted.execute(report,input,context,'0x'+'b'.repeat(40),input.nowMs),receipt);
 assert.deepEqual(await restarted.execute(report,input,context,'0x'+'b'.repeat(40),input.nowMs),receipt);
 assert.equal(simulations,1);assert.equal(reconciliations,1);
 }finally{await db.close();}
});

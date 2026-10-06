import {test} from 'node:test';
import assert from 'node:assert/strict';
import {fixture} from './support/mirror-fixture.ts';
import {parseClearinghouseState} from '../packages/shared/src/hyperliquid.ts';
import {HyperliquidInfoClient} from '../packages/backend/src/info-client.ts';
import {produceSnapshot} from '../packages/backend/src/snapshot.ts';
function response(){const summary={accountValue:'1000.0000009',totalNtlPos:'100',totalMarginUsed:'50',totalRawUsd:'1000'};return {time:2900,marginSummary:summary,crossMarginSummary:summary,crossMaintenanceMarginUsed:'5',withdrawable:'950',assetPositions:[{type:'oneWay',position:{coin:'BTC',szi:'-1',positionValue:'100',leverage:{type:'cross',value:2},entryPx:'95'}}]};}
test('clearinghouse parser preserves signed notional and conservatively floors equity',()=>{
 const f=fixture(),state=parseClearinghouseState(response(),f.account.address,f.nowMs,1000);
 assert.equal(state.equityMicros,'1000000000');assert.deepEqual(state.positions,[{market:'BTC',notionalMicros:'-100000000'}]);
 const incomplete=response();incomplete.marginSummary.totalNtlPos='200';assert.throws(()=>parseClearinghouseState(incomplete,f.account.address,f.nowMs,1000),/incomplete/);
 assert.throws(()=>parseClearinghouseState(response(),f.account.address,5000,1000),/stale/);
});
test('read-only info client queries actual account and never exchange endpoint',async()=>{
 const f=fixture();let calls=0;
 const client=new HyperliquidInfoClient(async(url,options)=>{calls++;assert.equal(url,'https://api.hyperliquid.xyz/info');assert.deepEqual(JSON.parse(options!.body as string),{type:'clearinghouseState',user:f.account.address});assert.equal(options!.redirect,'error');return new Response(JSON.stringify(response()));});
 assert.equal((await client.account(f.account.address,f.nowMs,1000,new AbortController().signal)).address,f.account.address);
 assert.equal(calls,1);
 const oversized=new HyperliquidInfoClient(async()=>new Response(' '.repeat(250001)));
 await assert.rejects(()=>oversized.account(f.account.address,f.nowMs,1000,new AbortController().signal),/budget/);
});
test('snapshot producer publishes complete frozen identities only and rejects late/failed batches',async()=>{
 const f=fixture();const source=async(address:string)=>f.snapshot.sources.find(state=>state.address===address)!;
 const snapshot=await produceSnapshot(f.configuration,source,()=>f.nowMs,new AbortController().signal);
 assert.equal(snapshot.sources.length,5);
 await assert.rejects(()=>produceSnapshot(f.configuration,async()=>{throw new Error('fetch failure');},()=>f.nowMs,new AbortController().signal));
 await assert.rejects(()=>produceSnapshot(f.configuration,source,()=>100000,new AbortController().signal),/stale/);
});

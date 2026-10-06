import {expect,test} from 'bun:test';
import {paperFixture,NOW} from '../../../tests/support/paper-lifecycle-fixture.ts';
import {runCommitteeReview} from '../../cre-workflows/review/committee/workflow.ts';
import {proposeFreeze} from '../../shared/src/frozen.ts';
import {checkSnapshot} from '../../cre-workflows/mirror/snapshot';
import {computeExposures} from '../../shared/copy';
import {buildSnapshot} from '../../backend/src/snapshot';
import {Runner} from '../src/runner';
import {MemoryStore} from '../src/store';
import {createExchange} from '../src/exchange';
import {verifyEnvelope} from '../src/verify';
import {handleReport} from '../src/handler';
import type {InfoFn} from '../src/hyperliquid';
import {body,envelope,keys,registry} from './helpers';
import type {Hex} from 'viem';

test('rich committee output feeds the current snapshot, exposures report and dry-run executor',async()=>{
 const f=paperFixture({async call(){return null;}});
 const receipt=await runCommitteeReview(f.input.frame,f.input.policy,f.input.addresses,f.input.rich,NOW,f.deps);
 expect(receipt.manifest.status).toBe('VALID');expect(receipt.economicAuthority).toBe(false);
 const frozen=proposeFreeze(receipt.manifest,f.account,999,NOW);
 const configuration={...frozen,policy:{...frozen.policy}};
 const runAt=Math.ceil(NOW/600000)*600;
 const snapshot=await buildSnapshot(configuration,['BTC'],runAt,runAt-1,{
   async perp(_,dex){return {assetPositions:dex?[]:[{position:{coin:'BTC',szi:'0.01',positionValue:'1000'}}]};},
   async portfolio(){return [['day',{accountValueHistory:[[NOW,'1000']]}]];},
 });
 const weighted=checkSnapshot(snapshot,{frozenConfigurationHash:configuration.configurationHash,runAt,maxSnapshotAgeSeconds:120});
 const exposures=computeExposures(weighted);expect(exposures).toEqual([{asset:'BTC',exposureE9:800000000n}]);
 const reportBody=body({runId:`review-e2e-${runAt}`,configurationHash:frozen.configurationHash as Hex,account:f.account as Hex,asOf:BigInt(runAt),expiresAt:BigInt(runAt+300),exposures});
 const signed=await envelope(keys.slice(0,2),{body:reportBody});
 const verified=await verifyEnvelope(signed,registry);
 const store=new MemoryStore(),exchange=createExchange({dryRun:true});
 const info:InfoFn=async<T>(request:Record<string,unknown>):Promise<T>=>{
   let result:unknown;
   switch(request.type){
     case 'perpDexs':result=[null,{name:'xyz'}];break;
     case 'metaAndAssetCtxs':result=request.dex?[{universe:[]},[]]:[{universe:[{name:'BTC',szDecimals:5,maxLeverage:40}]},[{markPx:'100000',openInterest:'1000'}]];break;
     case 'clearinghouseState':result={assetPositions:[]};break;
     case 'portfolio':result=[['day',{accountValueHistory:[[NOW,'1000']]}]];break;
     default:throw Error('unexpected request');
   }
   return result as T;
 };
 const runner=new Runner({store,exchange,info,alert:async()=>{},now:()=>runAt*1000,config:{account:f.account as Hex,maxGrossLeverage:2,runTimeoutMs:1000,plan:{minOrderUsd:10,driftFraction:0.1,marginCap:0.95,slippageBps:50}}});
 let accepted:Promise<unknown>|undefined;
 const deps={mode:registry,frozenConfigurationHash:frozen.configurationHash,account:f.account,now:()=>runAt,maxLeadSeconds:0,maxTtlSeconds:300,claim:(id:string)=>store.claimReport(id),accept:()=>{accepted=runner.executeReport(verified,signed);}};
 expect((await handleReport(signed,deps)).body.status).toBe('accepted');await accepted;
 expect((await handleReport(signed,deps)).body.status).toBe('duplicate');
 const runs=await store.recentRuns(10);expect(runs).toHaveLength(1);expect(runs[0]).toMatchObject({dryRun:true,status:'executed'});
 expect(runs[0].plan?.orders).toHaveLength(1);expect(runs[0].plan?.orders[0].size).toBe('0.008');
 expect(exchange.recorded()).toHaveLength(2); // simulated leverage + IOC; no HTTP exchange send.
});

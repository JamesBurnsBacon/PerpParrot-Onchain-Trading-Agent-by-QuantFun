import {expect,test} from 'bun:test';
import {paperFixture,NOW} from '../../../tests/support/paper-lifecycle-fixture.ts';
import {runCommitteeReview} from '../../backend/review/committee/workflow.ts';
import {proposeFreeze} from '../../shared/src/frozen.ts';
import {targetsFromSnapshot} from '../../shared/copy';
import {buildSnapshot, keccakUtf8} from '../../backend/src/snapshot';
import {Runner} from '../src/runner';
import {MemoryStore} from '../src/store';
import {createExchange} from '../src/exchange';
import type {InfoFn} from '../src/hyperliquid';
import type {Hex} from 'viem';

// The whole pipeline in one process: AI review -> frozen configuration -> the backend's positions
// read and targets -> the executor's dry run.
test('reviewed sources become a snapshot, targets and a dry-run executor run',async()=>{
 const f=paperFixture({async call(){return null;}});
 const receipt=await runCommitteeReview(f.input.frame,f.input.policy,f.input.addresses,f.input.rich,NOW,f.deps);
 expect(receipt.manifest.status).toBe('VALID');expect(receipt.economicAuthority).toBe(false);
 const frozen=proposeFreeze(receipt.manifest,f.account,999,NOW);
 const configuration={...frozen,policy:{...frozen.policy}};
 const runAt=Math.ceil(NOW/600000)*600;
 const snapshot=await buildSnapshot(configuration,['BTC'],runAt,()=>((runAt-1)*1000),{
   async perp(_,dex){return {assetPositions:dex?[]:[{position:{coin:'BTC',szi:'0.01',positionValue:'1000'}}]};},
   async portfolio(){return [['day',{accountValueHistory:[[NOW,'1000']]}]];},
 });
 const exposures=targetsFromSnapshot(snapshot);expect(exposures).toEqual([{asset:'BTC',exposureE9:800000000n}]);
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
 const targets=async(at:number)=>({runId:`mirror-${at}`,runAt:at,snapshotHash:keccakUtf8(JSON.stringify(snapshot)) as Hex,configurationHash:configuration.configurationHash as Hex,account:configuration.account as Hex,exposures});
 const runner=new Runner({store,exchange,info,targets,alert:async()=>{},now:()=>runAt*1000,config:{account:f.account as Hex,frozenConfigurationHash:configuration.configurationHash,maxGrossLeverage:2,runTtlSeconds:300,runTimeoutMs:1000,plan:{minOrderUsd:10,driftFraction:0.1,marginCap:0.95,slippageBps:50}}});
 expect(await store.claimRun(`mirror-${runAt}`)).toBe(true);
 const run=await runner.executeRun(runAt);
 expect(run).toMatchObject({kind:'mirror',dryRun:true,status:'executed'});
 expect(run.plan?.orders).toHaveLength(1);expect(run.plan?.orders[0].size).toBe('0.008');
 expect(await store.claimRun(`mirror-${runAt}`)).toBe(false);
 expect(exchange.recorded()).toHaveLength(2); // simulated leverage + IOC; no HTTP exchange send.
});

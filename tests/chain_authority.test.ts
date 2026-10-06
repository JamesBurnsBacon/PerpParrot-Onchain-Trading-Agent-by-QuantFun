import {test} from 'node:test';
import assert from 'node:assert/strict';
import {decodeFunctionData,encodeFunctionResult,keccak256} from 'viem';
import {fixture} from './support/mirror-fixture.ts';
import {consumerAbi} from '../packages/shared/src/consumer.ts';
import {readFreezeAuthority} from '../packages/executor/src/chain-authority.ts';
import type {ConsumerDeployment,ReadOnlyRpc} from '../packages/executor/src/chain-authority.ts';
const deployment:ConsumerDeployment={address:'0x'+'1'.repeat(40),runtimeCodeHash:keccak256('0x6000'),forwarder:'0x'+'2'.repeat(40),workflowOwner:'0x'+'3'.repeat(40),reviewWorkflowId:'0x'+'4'.repeat(64),mirrorWorkflowId:'0x'+'5'.repeat(64),confirmations:1,maxBlockAgeMs:60000};
function rpcFixture(){const f=fixture(),calls:unknown[][]=[];const state:Record<string,unknown>={configurationHash:f.configuration.configurationHash,reviewHash:f.configuration.reviewHash,account:f.configuration.account,paused:false,forwarder:deployment.forwarder,workflowOwner:deployment.workflowOwner,reviewWorkflowId:deployment.reviewWorkflowId,mirrorWorkflowId:deployment.mirrorWorkflowId};
 const rpc:ReadOnlyRpc={async request(method,params){calls.push([method,params]);if(method==='eth_chainId')return '0x3e7';if(method==='eth_blockNumber')return '0xb';if(method==='eth_getBlockByNumber')return {number:'0xa',timestamp:'0x2',hash:'0x'+'6'.repeat(64)};if(method==='eth_getCode')return '0x6000';if(method==='eth_call'){const name=decodeFunctionData({abi:consumerAbi,data:(params[0] as {data:`0x${string}`}).data}).functionName;return encodeFunctionResult({abi:consumerAbi,functionName:name,result:state[name]} as Parameters<typeof encodeFunctionResult>[0]);}throw new Error('unexpected RPC');}};
 return {f,rpc,state,calls};}
test('freeze adapter pins canonical block and verifies code and immutable workflow authority',async()=>{
 const {f,rpc,state,calls}=rpcFixture();assert.equal((await readFreezeAuthority(rpc,deployment,f.configuration,f.nowMs,new AbortController().signal)).active,true);
 for(const [method,params] of calls as [string,unknown[]][])if(method==='eth_call'||method==='eth_getCode')assert.deepEqual(params[1],{blockHash:'0x'+'6'.repeat(64),requireCanonical:true});
 state.paused=true;assert.equal((await readFreezeAuthority(rpc,deployment,f.configuration,f.nowMs,new AbortController().signal)).active,false);
});
test('freeze adapter rejects wrong bytecode, workflow and stale chain state',async()=>{
 for(const field of ['forwarder','reviewHash','mirrorWorkflowId']){const {f,rpc,state}=rpcFixture();state[field]=field==='forwarder'?'0x'+'f'.repeat(40):'0x'+'f'.repeat(64);await assert.rejects(()=>readFreezeAuthority(rpc,deployment,f.configuration,f.nowMs,new AbortController().signal),/authority/);}
 const {f,rpc}=rpcFixture();await assert.rejects(()=>readFreezeAuthority(rpc,{...deployment,runtimeCodeHash:'0x'+'f'.repeat(64)},f.configuration,f.nowMs,new AbortController().signal),/bytecode/);
 await assert.rejects(()=>readFreezeAuthority(rpc,deployment,f.configuration,100000,new AbortController().signal),/stale/);
});

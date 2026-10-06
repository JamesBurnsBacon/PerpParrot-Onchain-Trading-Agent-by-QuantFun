import {encodeFunctionData,decodeFunctionResult,keccak256} from 'viem';
import {consumerAbi} from '../../shared/src/consumer.ts';
import {validateFrozenConfiguration} from '../../shared/src/frozen.ts';
import type {FrozenConfiguration,ConfirmedFreeze} from '../../shared/src/frozen.ts';
import {hashSchema} from '../../shared/src/execution-preview.ts';
export interface ReadOnlyRpc {request(method:string,params:unknown[],signal:AbortSignal):Promise<unknown>}
export interface ConsumerDeployment {
  address:string;runtimeCodeHash:string;forwarder:string;workflowOwner:string;
  reviewWorkflowId:string;mirrorWorkflowId:string;confirmations:number;maxBlockAgeMs:number;
}
/** Pins all reads to a canonical block hash and matches immutable deployment
 * identity. No fallback to a snapshot-supplied confirmation or latest block. */
export async function readFreezeAuthority(rpc:ReadOnlyRpc,inputDeployment:ConsumerDeployment,inputConfiguration:FrozenConfiguration,nowMs:number,signal:AbortSignal):Promise<ConfirmedFreeze> {
  const deployment=structuredClone(inputDeployment),configuration=structuredClone(inputConfiguration);
  validateFrozenConfiguration(configuration);
  for(const address of [deployment.address,deployment.forwarder,deployment.workflowOwner])if(!/^0x[0-9a-f]{40}$/.test(address)||/^0x0+$/.test(address))throw new Error('invalid deployment address');
  for(const hash of [deployment.runtimeCodeHash,deployment.reviewWorkflowId,deployment.mirrorWorkflowId]){hashSchema.parse(hash);if(/^0x0+$/.test(hash))throw new Error('invalid deployment hash');}
  if(!Number.isSafeInteger(nowMs)||!Number.isSafeInteger(deployment.confirmations)||deployment.confirmations<1||deployment.confirmations>100||!Number.isSafeInteger(deployment.maxBlockAgeMs)||deployment.maxBlockAgeMs<=0||deployment.maxBlockAgeMs>60000)throw new Error('invalid finality policy');
  const chain=await rpc.request('eth_chainId',[],signal),height=await rpc.request('eth_blockNumber',[],signal);
  function hexInteger(value:unknown):bigint{if(typeof value!=='string'||!/^0x(0|[1-9a-f][0-9a-f]*)$/.test(value))throw new Error('invalid RPC integer');return BigInt(value);}
  if(hexInteger(chain)!==BigInt(configuration.chainId))throw new Error('wrong RPC chain');
  const number=hexInteger(height)-BigInt(deployment.confirmations);if(number<0n)throw new Error('insufficient chain depth');
  const block=await rpc.request('eth_getBlockByNumber',['0x'+number.toString(16),false],signal) as {hash?:unknown;number?:unknown;timestamp?:unknown}|null;
  if(!block||hexInteger(block.number)!==number)throw new Error('missing confirmed block');
  const blockHash=hashSchema.parse(block.hash),blockMs=hexInteger(block.timestamp)*1000n;
  if(blockMs>BigInt(nowMs)||BigInt(nowMs)-blockMs>BigInt(deployment.maxBlockAgeMs)||blockMs<BigInt(configuration.frozenAtMs))throw new Error('stale or future chain authority');
  const selector={blockHash,requireCanonical:true};
  const code=await rpc.request('eth_getCode',[deployment.address,selector],signal);
  if(typeof code!=='string'||!/^0x([0-9a-f]{2})+$/.test(code)||keccak256(code as `0x${string}`)!==deployment.runtimeCodeHash)throw new Error('consumer bytecode mismatch');
  async function read(functionName:string):Promise<unknown>{
    const data=encodeFunctionData({abi:consumerAbi,functionName} as Parameters<typeof encodeFunctionData>[0]);
    const result=await rpc.request('eth_call',[{to:deployment.address,data},selector],signal);
    if(typeof result!=='string'||!/^0x[0-9a-f]*$/.test(result))throw new Error('invalid consumer reply');
    return decodeFunctionResult({abi:consumerAbi,functionName,data:result as `0x${string}`} as Parameters<typeof decodeFunctionResult>[0]);
  }
  const names=['configurationHash','reviewHash','account','paused','forwarder','workflowOwner','reviewWorkflowId','mirrorWorkflowId'];
  const values=await Promise.all(names.map(read)),state=Object.fromEntries(names.map((name,i)=>[name,values[i]]));
  const lower=(value:unknown)=>typeof value==='string'?value.toLowerCase():value;
  if(state.configurationHash!==configuration.configurationHash||state.reviewHash!==configuration.reviewHash||lower(state.account)!==configuration.account||lower(state.forwarder)!==deployment.forwarder||lower(state.workflowOwner)!==deployment.workflowOwner||state.reviewWorkflowId!==deployment.reviewWorkflowId||state.mirrorWorkflowId!==deployment.mirrorWorkflowId||typeof state.paused!=='boolean')throw new Error('consumer authority mismatch');
  return {configurationHash:configuration.configurationHash,account:configuration.account,chainId:configuration.chainId,active:!state.paused};
}

import {cre,consensusIdenticalAggregation,bytesToBase64,bytesToHex,encodeCallMsg,LAST_FINALIZED_BLOCK_NUMBER,protoBigIntToBigint,bigintToProtoBigInt,getNetwork,type Runtime,type HTTPSendRequester} from '@chainlink/cre-sdk';
import {hmac} from '@noble/hashes/hmac.js';
import {sha256} from '@noble/hashes/sha2.js';
import {hexToBytes as secretBytes,bytesToHex as digestHex} from '@noble/hashes/utils.js';
import {encodeFunctionData,decodeFunctionResult,keccak256} from 'viem';
import {consumerAbi} from '../../shared/src/consumer.ts';
import {commitment} from '../../shared/src/commitments.ts';
import {parseClearinghouseState} from '../../shared/src/hyperliquid.ts';
import {buildMirrorPlan} from '../mirror/core.ts';
import {selectSpotChecks} from '../mirror/operations.ts';
import {mirrorConfigSchema,snapshotSchema,accountSchema,type MirrorConfig} from './wire.ts';
import type {AccountState} from '../../shared/src/mirror-state.ts';
function bytes(value:unknown){return new TextEncoder().encode(JSON.stringify(value));}
/** Real SDK read path; deliberately PAPER-only, no report/write/order capability. */
export function onMirror(runtime:Runtime<MirrorConfig>){
 try {
  const config=mirrorConfigSchema.parse(runtime.config),startedAt=runtime.now().getTime(),slot=Math.floor(startedAt/600000);
  const selector=BigInt(config.chainSelector),network=getNetwork({chainFamily:'evm',chainSelector:selector});
  if(!network||BigInt(network.chainId)!==BigInt(config.configuration.chainId))throw new Error('chain selector mismatch');
  const evm=new cre.capabilities.EVMClient(selector),header=evm.headerByNumber(runtime,{blockNumber:LAST_FINALIZED_BLOCK_NUMBER}).result().header;
  if(!header?.blockNumber||header.hash.length!==32||header.timestamp*1000n>BigInt(startedAt)||BigInt(startedAt)-header.timestamp*1000n>BigInt(config.maxStateAgeMs))throw new Error('stale finalized block');
  const data=encodeFunctionData({abi:consumerAbi,functionName:'authority'});
  const reply=evm.callContract(runtime,{call:encodeCallMsg({from:config.configuration.account as `0x${string}`,to:config.consumer as `0x${string}`,data}),blockNumber:bigintToProtoBigInt(protoBigIntToBigint(header.blockNumber))}).result();
  const [chain,account,configurationHash,reviewHash,active,forwarder,owner,reviewId,mirrorId,codeHash]=decodeFunctionResult({abi:consumerAbi,functionName:'authority',data:bytesToHex(reply.data) as `0x${string}`});
  if(chain!==BigInt(config.configuration.chainId)||account.toLowerCase()!==config.configuration.account||configurationHash!==config.configuration.configurationHash||reviewHash!==config.configuration.reviewHash||!active||forwarder.toLowerCase()!==config.forwarder||owner.toLowerCase()!==config.workflowOwner||reviewId!==config.reviewWorkflowId||mirrorId!==config.mirrorWorkflowId||codeHash!==config.runtimeCodeHash)throw new Error('unconfirmed chain authority');
  const client=new cre.capabilities.HTTPClient();
  function fetchJson<T>(url:string,payload:unknown|undefined,parse:(value:unknown)=>T,validate:(value:unknown)=>T):T {
    const request={url,method:payload===undefined?'GET':'POST',...(payload===undefined?{}:{body:bytesToBase64(bytes(payload)),multiHeaders:{'Content-Type':{values:['application/json']}}}),timeout:'10s'};
    const node=(requester:HTTPSendRequester):string=>{
      const response=requester.sendRequest(request).result();if(response.statusCode!==200||response.body.length>250000)throw new Error('HTTP failed');
      const validated=parse(JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(response.body))),encoded=JSON.stringify(validated);
      if(new TextEncoder().encode(encoded).length>23000)throw new Error('observation exceeds consensus budget');return encoded;
    };
    return validate(JSON.parse(client.sendRequest(runtime,node,consensusIdenticalAggregation<string>())().result()));
  }
  const parseCode=(value:unknown):string=>{
    const response=value as {jsonrpc?:unknown;id?:unknown;error?:unknown;result?:unknown};
    if(!response||response.jsonrpc!=='2.0'||response.id!==1||response.error!==undefined||typeof response.result!=='string'||!/^0x([0-9a-f]{2})+$/.test(response.result))throw new Error('invalid code proof');
    return response.result;
  };
  const code=fetchJson(config.rpcUrl,{jsonrpc:'2.0',id:1,method:'eth_getCode',params:[config.consumer,{blockHash:bytesToHex(header.hash),requireCanonical:true}]},parseCode,value=>{if(typeof value!=='string'||!/^0x([0-9a-f]{2})+$/.test(value))throw new Error('invalid normalized code');return value;});
  if(keccak256(code as `0x${string}`)!==config.runtimeCodeHash)throw new Error('independent consumer code mismatch');
  const snapshot=fetchJson(config.snapshotUrl,undefined,value=>snapshotSchema.parse(value),value=>snapshotSchema.parse(value));
  const samplingKey=runtime.getSecret({id:'MIRROR_SAMPLING_KEY'}).result().value;
  if(!/^0x[0-9a-f]{64}$/.test(samplingKey)||/^0x0+$/.test(samplingKey))throw new Error('invalid sampling secret');
  // Snapshot is fixed by consensus before secret-keyed selection. Public chain
  // hashes alone let the backend predict which sources will be checked.
  const sampleContext=commitment('perpparrot:sample-context:v1',{blockHash:bytesToHex(header.hash),slot,configurationHash,snapshotHash:snapshot.snapshotHash});
  const seed='0x'+digestHex(hmac(sha256,secretBytes(samplingKey.slice(2)),bytes(sampleContext)));
  const sampledAddresses=selectSpotChecks(config.configuration,seed);
  function direct(address:string):AccountState {return fetchJson('https://api.hyperliquid.xyz/info',{type:'clearinghouseState',user:address},value=>{const time=(value as {time?:unknown})?.time;if(typeof time!=='number'||!Number.isSafeInteger(time))throw new Error('invalid exchange timestamp');return parseClearinghouseState(value,address,time,config.maxStateAgeMs);},value=>accountSchema.parse(value));}
  const executionAccount=direct(config.configuration.account),checks=sampledAddresses.map(direct);
  const finishedAt=runtime.now().getTime();if(finishedAt<startedAt||Math.floor(finishedAt/600000)!==slot)throw new Error('slot deadline exceeded');
  const result=buildMirrorPlan({configuration:config.configuration,confirmedFreeze:{configurationHash,account:config.configuration.account,chainId:config.configuration.chainId,active},snapshot,account:executionAccount,checks,sampledAddresses,markets:config.markets,nowMs:finishedAt,maxStateAgeMs:config.maxStateAgeMs,runId:`mirror:${slot}`});
  return {mode:'PAPER' as const,economicAuthority:false as const,resultJson:JSON.stringify(result)};
 }catch {return {mode:'PAPER' as const,economicAuthority:false as const,resultJson:JSON.stringify({status:'HOLD',reason:'CAPABILITY_OR_VALIDATION_FAILURE'})};}
}

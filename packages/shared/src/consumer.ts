import {encodeAbiParameters,parseAbiParameters,parseAbi} from 'viem';
import {hashSchema} from './execution-preview.ts';
export const consumerAbi=parseAbi([
  'function authority() view returns (uint256,address,bytes32,bytes32,bool,address,address,bytes32,bytes32,bytes32)',
  'function configurationHash() view returns (bytes32)',
  'function reviewHash() view returns (bytes32)',
  'function account() view returns (address)',
  'function paused() view returns (bool)',
  'function forwarder() view returns (address)',
  'function workflowOwner() view returns (address)',
  'function reviewWorkflowId() view returns (bytes32)',
  'function mirrorWorkflowId() view returns (bytes32)',
  'function reportExpiryMs(bytes32) view returns (uint64)',
  'function setPaused(bool)',
  'function onReport(bytes,bytes)',
]);
export interface ConsumerReport {kind:1|2;chainId:number;account:string;configurationHash:string;payloadHash:string;slot:number;issuedMs:number;expiresMs:number}
export function encodeConsumerReport(value:ConsumerReport):`0x${string}` {
  for(const n of [value.chainId,value.slot,value.issuedMs,value.expiresMs])if(!Number.isSafeInteger(n)||n<0)throw new Error('invalid consumer integer');
  if(value.chainId===0||!/^0x[0-9a-f]{40}$/.test(value.account)||value.expiresMs<=value.issuedMs||value.expiresMs-value.issuedMs>600000||![1,2].includes(value.kind)||value.kind===1&&value.slot!==0||value.kind===2&&value.slot!==Math.floor(value.issuedMs/600000))throw new Error('invalid consumer report');
  hashSchema.parse(value.configurationHash);hashSchema.parse(value.payloadHash);
  if(/^0x0+$/.test(value.configurationHash)||/^0x0+$/.test(value.payloadHash))throw new Error('empty consumer commitment');
  return encodeAbiParameters(parseAbiParameters('uint8,uint256,address,bytes32,bytes32,uint64,uint64,uint64'),
    [value.kind,BigInt(value.chainId),value.account as `0x${string}`,value.configurationHash as `0x${string}`,value.payloadHash as `0x${string}`,BigInt(value.slot),BigInt(value.issuedMs),BigInt(value.expiresMs)]);
}

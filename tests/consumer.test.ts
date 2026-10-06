import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createVM} from '@ethereumjs/vm';
import {createAddressFromString,hexToBytes,bytesToHex} from '@ethereumjs/util';
import {encodeAbiParameters,parseAbiParameters,encodeFunctionData,decodeFunctionResult} from 'viem';
import {compileConsumer} from './support/compile-consumer.ts';
import {consumerAbi,encodeConsumerReport} from '../packages/shared/src/consumer.ts';
const forwarder='0x'+'1'.repeat(40),owner='0x'+'2'.repeat(40),admin='0x'+'3'.repeat(40),account='0x'+'4'.repeat(40);
const review='0x'+'5'.repeat(64),mirror='0x'+'6'.repeat(64),config='0x'+'7'.repeat(64),payload='0x'+'8'.repeat(64);
const compiled=compileConsumer();
async function setup(){
 const vm=await createVM();
 await vm.stateManager.putCode(createAddressFromString(forwarder),hexToBytes('0x00'));
 const args=encodeAbiParameters(parseAbiParameters('address,address,address,address,bytes32,bytes32'),[forwarder as `0x${string}`,owner as `0x${string}`,admin as `0x${string}`,account as `0x${string}`,review as `0x${string}`,mirror as `0x${string}`]);
 const deployed=await vm.evm.runCall({caller:createAddressFromString(admin),data:hexToBytes(('0x'+compiled.evm.bytecode.object+args.slice(2)) as `0x${string}`),gasLimit:10000000n});
 assert.equal(deployed.execResult.exceptionError,undefined);assert.ok(deployed.createdAddress);
 const to=deployed.createdAddress!;
 async function call(functionName:string,args:readonly unknown[]=[],caller=forwarder){
   const data=encodeFunctionData({abi:consumerAbi,functionName,args} as Parameters<typeof encodeFunctionData>[0]);
   return vm.evm.runCall({to,caller:createAddressFromString(caller),data:hexToBytes(data),gasLimit:10000000n});
 }
 async function read(functionName:string,args:readonly unknown[]=[]){const result=await call(functionName,args);assert.equal(result.execResult.exceptionError,undefined);return decodeFunctionResult({abi:consumerAbi,functionName,args,data:bytesToHex(result.execResult.returnValue)} as Parameters<typeof decodeFunctionResult>[0]);}
 const metadata=(id=review,author=owner)=>id+'0'.repeat(20)+author.slice(2)+'0000';
 const report=(kind:1|2,overrides={})=>encodeConsumerReport({kind,chainId:1,account,configurationHash:config,payloadHash:payload,slot:0,issuedMs:0,expiresMs:600000,...overrides});
 return {call,read,metadata,report};
}
test('real EVM consumer freezes once, requires activation and binds mirror reports',async()=>{
 const {call,read,metadata,report}=await setup();
 assert.equal((await call('setPaused',[false],admin)).execResult.exceptionError?.error,'revert');
 assert.equal((await call('onReport',[metadata(),report(1)])).execResult.exceptionError,undefined);
 assert.equal(await read('configurationHash'),config);assert.equal(await read('paused'),true);
 assert.ok((await call('onReport',[metadata(),report(1)])).execResult.exceptionError);
 assert.ok((await call('onReport',[metadata(mirror),report(2)])).execResult.exceptionError);
 assert.equal((await call('setPaused',[false],admin)).execResult.exceptionError,undefined);
 assert.equal((await call('onReport',[metadata(mirror),report(2)])).execResult.exceptionError,undefined);
 assert.equal(await read('reportExpiryMs',[payload]),600000n);
 assert.ok((await call('onReport',[metadata(mirror),report(2)])).execResult.exceptionError);
});
test('real EVM rejects wrong caller, workflow, owner, chain, malformed metadata and expired payload',async()=>{
 for(const change of ['caller','workflow','owner','chain','metadata','expiry']){
  const {call,metadata,report}=await setup();
  const meta=change==='workflow'?metadata(mirror):change==='owner'?metadata(review,admin):change==='metadata'?'0x':metadata();
  const data=report(1,change==='chain'?{chainId:999}:{});
  const result=await call('onReport',[meta,change==='expiry'?data.slice(0,-64)+'0'.repeat(64):data],change==='caller'?admin:forwarder);
  assert.ok(result.execResult.exceptionError,change);
 }
});
test('consumer pause blocks new mirror acceptance and unauthorized administrators cannot resume',async()=>{
 const {call,metadata,report}=await setup();
 assert.equal((await call('onReport',[metadata(),report(1)])).execResult.exceptionError,undefined);
 assert.ok((await call('setPaused',[false],owner)).execResult.exceptionError);
 assert.equal((await call('setPaused',[false],admin)).execResult.exceptionError,undefined);
 assert.equal((await call('setPaused',[true],admin)).execResult.exceptionError,undefined);
 assert.ok((await call('onReport',[metadata(mirror),report(2)])).execResult.exceptionError);
});

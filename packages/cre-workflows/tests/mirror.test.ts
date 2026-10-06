import assert from 'node:assert/strict';
import {test,newTestRuntime,HttpActionsMock,EvmMock,ConsensusMock} from '@chainlink/cre-sdk/test';
import {bytesToBase64,getNetwork} from '@chainlink/cre-sdk';
import {encodeFunctionResult,keccak256} from 'viem';
import {fixture} from '../../../tests/support/mirror-fixture.ts';
import {consumerAbi} from '../../shared/src/consumer.ts';
import {commitment} from '../../shared/src/commitments.ts';
import {snapshotHash} from '../../shared/src/mirror-state.ts';
import {mirrorConfigSchema} from '../mirror-spike/wire.ts';
import {onMirror} from '../mirror-spike/handler.ts';
function configFixture(count=5){
 const f=fixture();f.configuration.chainId=1;
 if(count===25){f.configuration.sources=Array.from({length:25},(_,candidate)=>({candidate,sourceAddress:'0x'+(candidate+1).toString(16).padStart(40,'0'),weightUnits:20000,ceilingUnits:100000}));f.configuration.cashUnits=500000;f.snapshot.sources=f.configuration.sources.map(source=>({...f.snapshot.sources[0],address:source.sourceAddress}));}
 const {configurationHash:_,...payload}=f.configuration;f.configuration.configurationHash=commitment('perpparrot:frozen:v1',payload);
 f.snapshot.configurationHash=f.configuration.configurationHash;const {snapshotHash:__,...snapshot}=f.snapshot;f.snapshot.snapshotHash=snapshotHash(snapshot);
 const selector=getNetwork({chainFamily:'evm',chainSelectorName:'ethereum-mainnet'})!.chainSelector.selector;
 const config=mirrorConfigSchema.parse({schedule:'0 */10 * * * *',mode:'PAPER',configuration:f.configuration,snapshotUrl:'https://snapshots.example.com/current',chainSelector:selector.toString(),rpcUrl:'https://rpc.example.com/',consumer:'0x'+'d'.repeat(40),runtimeCodeHash:keccak256('0x6000'),forwarder:'0x'+'f'.repeat(40),workflowOwner:'0x'+'c'.repeat(40),reviewWorkflowId:'0x'+'1'.repeat(64),mirrorWorkflowId:'0x'+'2'.repeat(64),markets:f.markets,maxStateAgeMs:1000});
 return {f,config,selector};
}
function mockEvm(config:ReturnType<typeof configFixture>['config'],selector:bigint){
 const evm=EvmMock.testInstance(selector);let writes=0;
 evm.headerByNumber=()=>({header:{timestamp:'2',blockNumber:{absVal:'Cg==',sign:'1'},hash:bytesToBase64(new Uint8Array(32).fill(1))}});
 evm.callContract=()=>({data:bytesToBase64(Buffer.from(encodeFunctionResult({abi:consumerAbi,functionName:'authority',result:[1n,config.configuration.account as `0x${string}`,config.configuration.configurationHash as `0x${string}`,config.configuration.reviewHash as `0x${string}`,true,config.forwarder as `0x${string}`,config.workflowOwner as `0x${string}`,config.reviewWorkflowId as `0x${string}`,config.mirrorWorkflowId as `0x${string}`,config.runtimeCodeHash as `0x${string}`]}).slice(2),'hex'))});
 evm.writeReport=()=>{writes++;throw new Error('unexpected write');};return ()=>writes;
}
test('SDK mirror reads frozen authority, validates every sample, and stays within thirteen HTTP calls',()=>{
 const {f,config,selector}=configFixture(25),writes=mockEvm(config,selector);let calls=0;
 ConsensusMock.testInstance().simple=input=>{if(input.observation.case!=='value')throw new Error('missing consensus');return input.observation.value;};
 HttpActionsMock.testInstance().sendRequest=request=>{
  calls++;assert.equal(request.cacheSettings,undefined);
  if(request.url===config.rpcUrl)return {statusCode:200,body:bytesToBase64(new TextEncoder().encode(JSON.stringify({jsonrpc:'2.0',id:1,result:'0x6000'})))};
  if(request.method==='GET')return {statusCode:200,body:bytesToBase64(new TextEncoder().encode(JSON.stringify(f.snapshot)))};
  assert.equal(request.url,'https://api.hyperliquid.xyz/info');const query=JSON.parse(new TextDecoder().decode(request.body));
  assert.equal(query.type,'clearinghouseState');const state=query.user===f.account.address?f.account:f.snapshot.sources.find(s=>s.address===query.user)!;
  const summary={accountValue:'1000',totalNtlPos:state.positions.length?'1000':'0',totalMarginUsed:'0',totalRawUsd:'1000'};
  return {statusCode:200,body:bytesToBase64(new TextEncoder().encode(JSON.stringify({time:state.observedAtMs,marginSummary:summary,crossMarginSummary:summary,crossMaintenanceMarginUsed:'0',withdrawable:'1000',assetPositions:state.positions.map(p=>({type:'oneWay',position:{coin:p.market,szi:'10',positionValue:'1000',leverage:{type:'cross',value:2}}}))})))};
 };
 const result=onMirror(newTestRuntime(new Map([['main',new Map([['MIRROR_SAMPLING_KEY','0x'+'9'.repeat(64)]])]]),{timeProvider:()=>3000},config));
 assert.equal(JSON.parse(result.resultJson).status,'READY');assert.equal(result.mode,'PAPER');assert.equal(result.economicAuthority,false);assert.equal(calls,13);assert.equal(writes(),0);assert.doesNotMatch(result.resultJson,/99999999999999999999999999999999/);
});
test('SDK mirror fails closed on snapshot fetch failure without fallback or chain writes',()=>{
 const {config,selector}=configFixture(),writes=mockEvm(config,selector);let calls=0;
 HttpActionsMock.testInstance().sendRequest=()=>{calls++;return {statusCode:503,body:bytesToBase64(new TextEncoder().encode('sensitive upstream payload'))};};
 const result=onMirror(newTestRuntime(new Map([['main',new Map([['MIRROR_SAMPLING_KEY','0x'+'9'.repeat(64)]])]]),{timeProvider:()=>3000},config));assert.equal(JSON.parse(result.resultJson).status,'HOLD');assert.equal(calls,1);assert.equal(writes(),0);assert.doesNotMatch(result.resultJson,/sensitive/);
});
test('SDK mirror never checks or plans sources without the private sampling secret',()=>{
 const {f,config,selector}=configFixture(),writes=mockEvm(config,selector);let sourceCalls=0;
 HttpActionsMock.testInstance().sendRequest=request=>{
  if(request.url===config.rpcUrl)return {statusCode:200,body:bytesToBase64(new TextEncoder().encode(JSON.stringify({jsonrpc:'2.0',id:1,result:'0x6000'})))};
  if(request.method==='GET')return {statusCode:200,body:bytesToBase64(new TextEncoder().encode(JSON.stringify(f.snapshot)))};
  sourceCalls++;throw new Error('must not call sources');
 };
 const result=onMirror(newTestRuntime(null,{timeProvider:()=>3000},config));
 assert.equal(JSON.parse(result.resultJson).status,'HOLD');assert.equal(sourceCalls,0);assert.equal(writes(),0);
});

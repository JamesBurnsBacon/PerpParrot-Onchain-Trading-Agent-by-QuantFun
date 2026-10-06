import assert from 'node:assert/strict';
import {test, newTestRuntime, HttpActionsMock, ConsensusMock} from '@chainlink/cre-sdk/test';
import {bytesToBase64, median} from '@chainlink/cre-sdk';
import config from '../review-spike/config.simulation.json' with {type:'json'};
import {configSchema, FIELDS} from '../review-spike/wire.ts';
import {onReview} from '../review-spike/handler.ts';

test('real SDK HTTP and secret plumbing yields simulation-only numeric output without caching or secret logging', () => {
  let calls=0;
  let consensusCalls=0;
  ConsensusMock.testInstance().simple=input => {
    consensusCalls++;
    assert.equal(input.default,undefined); // No manufactured fallback score.
    assert.equal(input.descriptors?.descriptor.case,'fieldsMap');
    const descriptor=input.descriptors!.descriptor;
    if(descriptor.case!=='fieldsMap' || input.observation.case!=='value')throw new Error('invalid consensus request');
    assert.equal(Object.keys(descriptor.value.fields).length,config.evidence.finalists.length*FIELDS.length);
    for(const field of Object.keys(descriptor.value.fields).sort()) assert.deepEqual(descriptor.value.fields[field].descriptor,median<number>().fieldDescriptor!.descriptor);
    return input.observation.value;
  };
  const runtime = newTestRuntime(new Map([['main',new Map([['OPENAI_API_KEY','test-only-dummy-key']])]]),{timeProvider:()=>30000},configSchema.parse(config));
  HttpActionsMock.testInstance().sendRequest=request => {
    calls++;
    assert.equal(request.url,'https://api.openai.com/v1/chat/completions');
    assert.equal(request.method,'POST');
    assert.equal(request.cacheSettings,undefined);
    assert.equal(request.multiHeaders.Authorization.values[0],'Bearer test-only-dummy-key');
    const payload=JSON.parse(new TextDecoder().decode(request.body));
    assert.equal(payload.response_format.type,'json_schema');
    assert.equal(payload.store,false);
    const results=config.evidence.finalists.map(f => ({candidate:f.candidate,...Object.fromEntries(FIELDS.map(field => [field,50]))}));
    return {statusCode:200,body:bytesToBase64(new TextEncoder().encode(JSON.stringify({choices:[{finish_reason:'stop',message:{content:JSON.stringify({results})}}]})))};
  };
  const result=onReview(runtime);
  assert.equal(calls,1); // Test harness is one node; not a deployed DON call count.
  assert.equal(consensusCalls,1);
  assert.equal(result.mode,'SIMULATION');assert.equal(result.economicAuthority,false);
  assert.equal(result.scores.c0_risk,50);
  assert.equal(result.asOfMs,30000);
  assert.ok(runtime.getLogs().every(log => !log.includes('test-only-dummy-key')));
  assert.doesNotMatch(JSON.stringify(result),/test-only-dummy-key|Bearer/);
});
test('HTTP failure exits without echoing provider errors or credentials', () => {
  const runtime = newTestRuntime(new Map([['main',new Map([['OPENAI_API_KEY','test-only-dummy-key']])]]),{},configSchema.parse(config));
  HttpActionsMock.testInstance().sendRequest=() => ({statusCode:429,body:bytesToBase64(new TextEncoder().encode('SENSITIVE ERROR'))});
  assert.throws(() => onReview(runtime),error => error instanceof Error && error.message.includes('429') && !error.message.includes('SENSITIVE') && !error.message.includes('dummy-key'));
  assert.deepEqual(runtime.getLogs(),[]);
});
test('missing model secret fails before any HTTP capability call', () => {
  const runtime=newTestRuntime(null,{},configSchema.parse(config));let calls=0;
  HttpActionsMock.testInstance().sendRequest=() => {calls++;return {statusCode:500};};
  assert.throws(() => onReview(runtime));assert.equal(calls,0);
});

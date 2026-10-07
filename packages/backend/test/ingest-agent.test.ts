import {expect,test} from 'bun:test';
import {analyseStrategies,agentOptions} from '../src/ingest/strategy-agent';
import type {Transport} from '../src/ingest/client';
const evidence={candidates:[{candidate:0,kind:'HYPERCORE_VAULT',metrics:{makerShare:0.9},positions:[]}]};
const result={candidates:[{candidate:0,strategy:'Possible passive liquidity provision; unproven entry rules.',confidence:'low' as const,
  evidence:[{field:'metrics.makerShare',observation:'Observed maker share is 90%.'}],risks:['Unknown leverage history'],unknowns:['Entry rules']}]};
for(const provider of ['openai','anthropic'] as const)test(`${provider}: bounded strategy response with exact candidate mapping`,async()=>{
  const fetcher:Transport=async(url,init)=>{
    expect(url).toBe(provider==='openai'?'https://api.openai.com/v1/chat/completions':'https://api.anthropic.com/v1/messages');
    const body=JSON.parse(String(init?.body));expect(JSON.stringify(body)).not.toContain('0x');
    expect(provider==='openai'?body.response_format.json_schema.strict:body.output_config.format.type).toBe(provider==='openai'?true:'json_schema');
    return Response.json(provider==='openai'?{choices:[{finish_reason:'stop',message:{content:JSON.stringify(result)}}]}:
      {stop_reason:'end_turn',content:[{type:'text',text:JSON.stringify(result)}]});
  };
  const actual=await analyseStrategies(evidence,{provider,model:'test-model',apiKey:'test-not-a-secret',fetcher},new AbortController().signal);
  expect(actual.economicAuthority).toBe(false);expect(actual.analysis).toEqual(result);expect(actual.inputHash).toMatch(/^[a-f0-9]{64}$/);
});
test('model identities and nonexistent evidence cannot be accepted',async()=>{
  for(const bad of [{...result,candidates:[{...result.candidates[0],candidate:3}]},
    {...result,candidates:[{...result.candidates[0],evidence:[{field:'metrics.missing',observation:'invented'}]}]}]){
    await expect(analyseStrategies(evidence,{provider:'openai',model:'test',apiKey:'test',
      fetcher:async()=>Response.json({choices:[{finish_reason:'stop',message:{content:JSON.stringify(bad)}}]})},new AbortController().signal)).rejects.toThrow();
  }
});
test('truncated or refused model responses do not become analysis',async()=>{
  for(const row of [{finish_reason:'length',message:{content:JSON.stringify(result)}},
    {finish_reason:'stop',message:{content:'{}',refusal:'refused'}}]){
    await expect(analyseStrategies(evidence,{provider:'openai',model:'test',apiKey:'test',fetcher:async()=>Response.json({choices:[row]})},new AbortController().signal)).rejects.toThrow();
  }
});
test('no model configuration does not manufacture an analysis',()=>{
  expect(agentOptions({})).toBeUndefined();expect(agentOptions({INGEST_AGENT_PROVIDER:'openai',INGEST_AGENT_MODEL:'test'})).toBeUndefined();
  expect(()=>agentOptions({INGEST_AGENT_PROVIDER:'other',INGEST_AGENT_MODEL:'test'})).toThrow();
});

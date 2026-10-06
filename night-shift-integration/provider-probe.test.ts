import {test,expect} from 'bun:test';
import {providerTransport,MODELS,type ProviderCall} from './provider-probe.ts';
const endpoint='https://api.openai.com/v1/chat/completions';
const request=(model:string,stage:string)=>({method:'POST',body:JSON.stringify({model,response_format:{json_schema:{name:'paper_'+stage}}})});
test('provider transport allows only two pinned models and one request per stage, without retries',async()=>{
 const calls:ProviderCall[]=[];let invoked=0;
 const transport=providerTransport(calls,(async()=>{invoked++;return new Response('{}',{status:200});}) as unknown as typeof fetch);
 for(const model of MODELS)for(const stage of ['role','risk','redteam'])await transport(endpoint,request(model,stage));
 expect(invoked).toBe(6);expect(calls).toHaveLength(6);
 await expect(transport(endpoint,request(MODELS[0],'role'))).rejects.toThrow('BUDGET');
 expect(invoked).toBe(6);expect(calls.every(c=>c.httpStatus===200&&c.responseValidated===false)).toBe(true);
});
test('provider transport refuses changed endpoint/model and stores no error contents or bearer token',async()=>{
 const calls:ProviderCall[]=[];let invoked=0;
 const transport=providerTransport(calls,(async()=>{invoked++;throw Error('Bearer fake-private-secret');}) as unknown as typeof fetch);
 await expect(transport('https://invalid.example',request(MODELS[0],'role'))).rejects.toThrow('DESTINATION');
 await expect(transport(endpoint,request('gpt-other','role'))).rejects.toThrow('BUDGET');
 expect(invoked).toBe(0);
 await expect(transport(endpoint,request(MODELS[0],'risk'))).rejects.toThrow('NETWORK_FAILURE');
 expect(invoked).toBe(1);expect(calls[0].transport).toBe('NETWORK_ERROR');
 expect(JSON.stringify(calls)).not.toContain('private-secret');
 await expect(transport(endpoint,request(MODELS[0],'risk'))).rejects.toThrow('BUDGET');
 expect(invoked).toBe(1);
});
test('HTTP failure records only numeric status and remains one attempted request',async()=>{
 const calls:ProviderCall[]=[];
 const transport=providerTransport(calls,(async()=>new Response('sensitive upstream body',{status:401})) as unknown as typeof fetch);
 const response=await transport(endpoint,request(MODELS[0],'role'));
 expect(response.status).toBe(401);expect(calls[0].httpStatus).toBe(401);
 expect(JSON.stringify(calls)).not.toContain('sensitive');expect(calls).toHaveLength(1);
});

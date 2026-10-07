import {test} from 'node:test';
import assert from 'node:assert/strict';
import {kimiPaperCommittee} from '../packages/backend/review/models/kimi-paper.ts';
import {commitment} from '../packages/shared/src/commitments.ts';
import {openAIPaperCommittee} from '../packages/backend/review/models/openai-paper.ts';
import {runCommitteeReview} from '../packages/backend/review/committee/workflow.ts';
import {paperFixture,NOW} from './support/paper-lifecycle-fixture.ts';
const model='gpt-4.1-mini-2025-04-14',prompts={role:'role',risk:'risk',redteam:'critique'};
const roleFields=['preserver','compounder','diversifier','directional','opportunistic','convexity','reject','conservativeFit','balancedFit','aggressiveFit','confidence'];
const riskFields=['drawdownRisk','leverageRisk','concentrationRisk','pathRisk','executionRisk','evidenceRisk','confidence'];
function setup(scenario='valid',selectedModel=model){
 const f=paperFixture({async call(){return null;}});let calls=0;
 const fetcher:typeof fetch=async(url,init)=>{
   calls++;assert.equal(url,selectedModel==='kimi-k3'?'https://api.moonshot.cn/v1/chat/completions':'https://api.openai.com/v1/chat/completions');assert.equal(init?.redirect,'error');assert.ok(init?.signal);
   const body=JSON.parse(String(init?.body));assert.equal(body.store,false);assert.equal(body.response_format.json_schema.strict,true);
   assert.equal(body.model,selectedModel);
   if(['gpt-6-sol','kimi-k3'].includes(selectedModel)){assert.equal(body.reasoning_effort,'high');assert.equal(body.max_completion_tokens,32768);assert.ok(!Object.hasOwn(body,'temperature'));}
   else {assert.equal(body.temperature,0);assert.equal(body.max_completion_tokens,8192);assert.ok(!Object.hasOwn(body,'reasoning_effort'));}
   const input=JSON.parse(body.messages[1].content),schema=body.response_format.json_schema.schema;
   assert.equal(input.evidence.finalists.length,5);assert.equal(input.evidence.finalists[0].equityCurve.length,26);assert.ok(input.evidence.finalists[0].positions);
   const stage=body.response_format.json_schema.name;
   let output:Record<string,unknown>;
   if(stage==='paper_redteam'){assert.ok(input.draft.draftHash);output={rebuildScore:0,portfolioRisk:0,penalties:input.draft.sources.map((s:{candidate:number})=>({candidate:s.candidate,multiplier:1,excludeScore:0}))};}
   else {const fields=stage==='paper_role'?roleFields:riskFields;output={results:input.evidence.finalists.map((s:{candidate:number})=>({candidate:s.candidate,...Object.fromEntries(fields.map(field=>[field,field==='confidence'?90:field==='reject'?0:stage==='paper_risk'?20:90]))}))};}
   if(scenario==='extra')output.apiKey='untrusted';
   if(scenario==='duplicate'&&stage!=='paper_redteam')(output.results as {candidate:number}[])[1].candidate=0;
   return new Response(JSON.stringify({model:scenario==='model'?'different-model':selectedModel,choices:[{finish_reason:scenario==='truncated'?'length':'stop',message:{content:JSON.stringify(output),refusal:scenario==='refusal'?'refused':null}}]}));
 };
 const deps=(selectedModel==='kimi-k3'?kimiPaperCommittee:openAIPaperCommittee)({apiKey:'local-test-key',model:selectedModel,prompts,fetcher},{...f.deps,audit:async(stage,_,rows)=>rows.map((__,i)=>'0x'+String(i+1+(['role','risk','redteam'].indexOf(stage)*2)).repeat(64))});
 return {f,deps,calls:()=>calls};
}
test('server paper provider consumes full evidence and critique draft with one honest local node',async()=>{
 const s=setup();assert.deepEqual(s.deps.nodeIds,['paper-provider']);assert.equal(s.deps.quorum,1);
 const receipt=await runCommitteeReview(s.f.input.frame,s.f.input.policy,s.f.input.addresses,s.f.input.rich,NOW,s.deps);
 assert.equal(receipt.manifest.status,'VALID');assert.equal(s.calls(),3);assert.equal(receipt.economicAuthority,false);
});
test('provider refuses unknown outputs, duplicate candidates, model drift, refusal and truncation',async()=>{
 for(const selectedModel of [model,'gpt-6-sol','kimi-k3'])for(const scenario of ['extra','duplicate','model','refusal','truncated']){const s=setup(scenario,selectedModel);const result=await runCommitteeReview(s.f.input.frame,s.f.input.policy,s.f.input.addresses,s.f.input.rich,NOW,s.deps);assert.equal(result.manifest.status,'INVALID_BUCKET',scenario);assert.equal(result.manifest.reason,'AGENT_FAILURE',scenario);}
});
test('Sol uses high reasoning with bound parameters and strict model identity in all three stages',async()=>{
 const s=setup('valid','gpt-6-sol');assert.notEqual(s.deps.modelConfigHash,setup().deps.modelConfigHash);
 const receipt=await runCommitteeReview(s.f.input.frame,s.f.input.policy,s.f.input.addresses,s.f.input.rich,NOW,s.deps);
 assert.equal(receipt.manifest.status,'VALID');assert.equal(s.calls(),3);assert.equal(receipt.economicAuthority,false);
});

test('K3 high uses the same three-stage validators with a distinct provider commitment',async()=>{
 const s=setup('valid','kimi-k3'),sol=setup('valid','gpt-6-sol');
 assert.notEqual(s.deps.modelConfigHash,sol.deps.modelConfigHash);
 const receipt=await runCommitteeReview(s.f.input.frame,s.f.input.policy,s.f.input.addresses,s.f.input.rich,NOW,s.deps);
 assert.equal(receipt.manifest.status,'VALID');assert.equal(s.calls(),3);assert.equal(receipt.economicAuthority,false);
 assert.throws(()=>kimiPaperCommittee({apiKey:'test',model:'kimi-other'},s.f.deps));
 assert.throws(()=>kimiPaperCommittee({apiKey:'test',model:'kimi-k3',endpoint:'https://example.com'},s.f.deps));
});
test('shared transport extraction preserves both existing OpenAI model commitments',()=>{
 const promptHashes=Object.fromEntries(Object.entries(prompts).map(([stage,prompt])=>[stage,commitment('perpparrot:prompt:v1',prompt)]));
 assert.equal(setup().deps.modelConfigHash,commitment('perpparrot:model:v1',{provider:'openai',model,temperature:0,promptHashes}));
 assert.equal(setup('valid','gpt-6-sol').deps.modelConfigHash,commitment('perpparrot:model:v1',{provider:'openai',model:'gpt-6-sol',reasoning_effort:'high',max_completion_tokens:32768,promptHashes}));
});

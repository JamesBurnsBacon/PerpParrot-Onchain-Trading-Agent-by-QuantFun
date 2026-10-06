import {test} from 'node:test';
import assert from 'node:assert/strict';
import {buildReviewInput} from '../packages/backend/review/input.ts';
import {runReview,type Dependencies} from '../packages/cre-workflows/review/workflow.ts';
import {SPECIALIST_FIELDS,createSpecialist,modelConfigHash,openAIChat,parseSpecialist,specialistRequest,type ModelCall,type ModelConfig,type Specialist} from '../packages/shared/src/specialists.ts';
import {RED_TEAM_PROMPT,RISK_PROMPT,ROLE_PROMPT,promptHash} from '../packages/shared/src/prompts.ts';
import {setup,address,NOW} from './support/score-frame.ts';
const config:ModelConfig={provider:'openai',model:'gpt-4.1-mini-2025-04-14',temperature:0,maxCompletionTokens:4096};
const encode=(value:unknown)=>new TextEncoder().encode(JSON.stringify(value));
const reply=(content:unknown,finish='stop')=>encode({choices:[{finish_reason:finish,message:{content:JSON.stringify(content)}}]});
const rows=(kind:Specialist,ids:number[],value=70)=>({results:ids.map(candidate=>({candidate,...Object.fromEntries(SPECIALIST_FIELDS[kind].map(f=>[f,value]))}))});
// A fake provider that answers from the strict schema it was sent (what a structured-output model returns).
const fakeModel=(value=70):ModelCall=>async body=>{
  const schema=(body as {response_format:{json_schema:{name:string;schema:{properties:{results:{items:{properties:{candidate:{enum:number[]}}}}}}}}}).response_format.json_schema;
  return reply(rows(schema.name==='perpparrot_role'?'role':'risk',schema.schema.properties.results.items.properties.candidate.enum,value));
};
test('output fields come from the consensus schemas',()=>{
  assert.deepEqual(SPECIALIST_FIELDS.role,['preserver','compounder','diversifier','directional','opportunistic','convexity','reject','conservativeFit','balancedFit','aggressiveFit','confidence']);
  assert.deepEqual(SPECIALIST_FIELDS.risk,['drawdownRisk','leverageRisk','concentrationRisk','pathRisk','executionRisk','evidenceRisk','confidence']);
});
test('request: specialist prompt as system, anonymous committee evidence as user, strict integer rows',()=>{
  const {committee}=buildReviewInput(setup());
  const body=specialistRequest('risk',committee,config) as {messages:{role:string;content:string}[];response_format:{json_schema:{strict:boolean;schema:{properties:{results:{minItems:number;items:{properties:Record<string,{type:string}>}}}}}};temperature:number;store:boolean};
  assert.equal(body.messages[0]!.content,RISK_PROMPT);
  assert.deepEqual(JSON.parse(body.messages[1]!.content),committee);
  for(const n of [1,2,99])assert.ok(!body.messages[1]!.content.includes(address(n)));
  const schema=body.response_format.json_schema;
  assert.equal(schema.strict,true);assert.equal(schema.schema.properties.results.minItems,2);
  assert.equal(schema.schema.properties.results.items.properties.leverageRisk!.type,'integer');
  assert.equal(body.temperature,0);assert.equal(body.store,false);
});
test('parse: exactly the candidates, integers 0–100, no extra fields, no refusals',()=>{
  assert.equal(parseSpecialist('role',reply(rows('role',[1,0])),[0,1]).map(r=>r.candidate).join(),'0,1');
  const bad:[string,Uint8Array][]=[
    ['missing candidate',reply(rows('role',[0]))],
    ['unknown candidate',reply(rows('role',[0,5]))],
    ['fractional score',reply(rows('role',[0,1],70.5))],
    ['score above 100',reply(rows('role',[0,1],101))],
    ['extra field',reply({results:rows('role',[0,1]).results.map(r=>({...r,weight:0.5}))})],
    ['truncated',reply(rows('role',[0,1]),'length')],
    ['refusal',encode({choices:[{finish_reason:'stop',message:{refusal:'no',content:'{}'}}]})],
    ['not JSON',new TextEncoder().encode('<html>')],
  ];
  for(const [name,body] of bad)assert.throws(()=>parseSpecialist('role',body,[0,1]),Error,name);
});
test('end to end: specialists feed runReview; observations bind to the frame, prompts and model config',async()=>{
  const args=setup(),{frame,committee,addresses}=buildReviewInput(args),nodeIds=['n1','n2','n3'];
  const failures:string[]=[];
  // n3 fails: the other two still meet quorum 2.
  const call:ModelCall=async(body,signal)=>{if(calls++%3===2)throw new Error('provider HTTP 500');return fakeModel()(body,signal);};
  let calls=0;
  const make=(kind:Specialist)=>createSpecialist({kind,evidence:committee,config,nodeIds,call,onError:(node,error)=>failures.push(`${kind}:${node}:${error.message}`)});
  const observations=await make('role')(frame,new AbortController().signal);
  assert.equal(observations.length,2);
  assert.ok(observations.every(o=>o.promptHash===promptHash(ROLE_PROMPT)&&o.modelConfigHash===modelConfigHash(config)&&o.snapshotHash===frame.snapshotHash));
  const deps:Dependencies={quorum:2,nodeIds,agentTimeoutMs:5000,clock:()=>NOW+1000,rolePromptHash:promptHash(ROLE_PROMPT),riskPromptHash:promptHash(RISK_PROMPT),redTeamPromptHash:promptHash(RED_TEAM_PROMPT),modelConfigHash:modelConfigHash(config),
    role:make('role'),risk:make('risk'),redTeam:async()=>{throw new Error('red-team adapter not built');},assess:()=>{throw new Error('not reached');}};
  const manifest=await runReview(frame,args.policy,addresses,NOW+1000,deps);
  // Models answered and passed quorum; the deterministic compile step then rejects every candidate for
  // missing out-of-sample and execution evidence, which the backtest and execution modules must supply.
  assert.equal(manifest.reason,'INSUFFICIENT_EVIDENCE');
  assert.ok(failures.length>0&&failures.every(f=>f.endsWith('provider HTTP 500')));
});
test('a specialist refuses evidence bound to a different frame',async()=>{
  const first=buildReviewInput(setup()),other=buildReviewInput({...setup(),asOfMs:NOW-60_000});
  const specialist=createSpecialist({kind:'role',evidence:other.committee,config,nodeIds:['n1'],call:fakeModel()});
  await assert.rejects(specialist(first.frame,new AbortController().signal),/not bound to this frame/);
});
test('openAIChat: bearer key in the header only, HTTP errors without request details',async()=>{
  const seen:{url:string;init:RequestInit}[]=[];
  const fakeFetch=(async(url:string,init:RequestInit)=>{seen.push({url,init});return new Response(seen.length===1?'{"ok":1}':'secret echo',{status:seen.length===1?200:429});}) as unknown as typeof fetch;
  const call=openAIChat('sk-test',{fetch:fakeFetch});
  assert.equal(new TextDecoder().decode(await call({model:'m'},new AbortController().signal)),'{"ok":1}');
  assert.equal(seen[0]!.url,'https://api.openai.com/v1/chat/completions');
  assert.equal((seen[0]!.init.headers as Record<string,string>).Authorization,'Bearer sk-test');
  assert.ok(!String(seen[0]!.init.body).includes('sk-test'));
  await assert.rejects(call({model:'m'},new AbortController().signal),(error:Error)=>error.message==='provider HTTP 429');
  assert.throws(()=>openAIChat(''),/missing model API key/);
});

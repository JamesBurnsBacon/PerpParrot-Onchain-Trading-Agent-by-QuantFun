import {test} from 'node:test';
import assert from 'node:assert/strict';
import {buildReviewInput} from '../packages/backend/review/input.ts';
import {openAIPaperCommittee} from '../packages/backend/review/models/openai-paper.ts';
import {kimiPaperCommittee} from '../packages/backend/review/models/kimi-paper.ts';
import {runCommitteeReview} from '../packages/backend/review/committee/workflow.ts';
import {RED_TEAM_PROMPT,RISK_PROMPT,ROLE_PROMPT,promptHash} from '../packages/shared/src/prompts.ts';
import {setup,address,NOW} from './support/score-frame.ts';
const model='gpt-4.1-mini-2025-04-14',endpoint='http://localhost:9/v1/chat/completions';
// Answers each request from the strict schema it carries, like a structured-output model.
function fakeProvider(seen:{url:string;system:string;user:string}[]):typeof fetch {
  return (async(url:string,init:RequestInit)=>{
    const body=JSON.parse(String(init.body)),schema=body.response_format.json_schema.schema;
    seen.push({url,system:body.messages[0].content,user:body.messages[1].content});
    const rows=(items:{properties:Record<string,unknown>&{candidate:{enum:number[]}}})=>items.properties.candidate.enum.map(candidate=>({candidate,...Object.fromEntries(Object.keys(items.properties).filter(k=>k!=='candidate').map(k=>[k,k==='reject'?0:k==='multiplier'?1:60]))}));
    const output=schema.properties.results?{results:rows(schema.properties.results.items)}:{rebuildScore:0,portfolioRisk:0,penalties:rows(schema.properties.penalties.items)};
    return new Response(JSON.stringify({model:body.model,choices:[{finish_reason:'stop',message:{content:JSON.stringify(output),refusal:null}}]}));
  }) as unknown as typeof fetch;
}
test('Score input -> committee provider -> review: doc prompts, anonymous evidence, audited, fails closed',async()=>{
  const args=setup(),{frame,evidence,addresses}=buildReviewInput(args),seen:{url:string;system:string;user:string}[]=[],audited:string[]=[];
  const deps=openAIPaperCommittee({apiKey:'local-test-key',model,endpoint,fetcher:fakeProvider(seen)},{
    clock:()=>NOW+1000,agentTimeoutMs:5000,assess:()=>{throw new Error('not reached');},
    audit:async(stage,_,rows)=>rows.map((__,i)=>{audited.push(stage);return '0x'+String(audited.length+i).padStart(64,'0');}),
  });
  assert.equal(deps.rolePromptHash,promptHash(ROLE_PROMPT));assert.equal(deps.riskPromptHash,promptHash(RISK_PROMPT));assert.equal(deps.redTeamPromptHash,promptHash(RED_TEAM_PROMPT));
  const receipt=await runCommitteeReview(frame,args.policy,addresses,evidence,NOW+1000,deps);
  // Role and Risk answered, were audited and passed quorum; compile then rejects every candidate for
  // missing out-of-sample and execution evidence, so the red team is never reached.
  assert.equal(receipt.manifest.reason,'INSUFFICIENT_EVIDENCE');assert.deepEqual(audited.sort(),['risk','role']);
  assert.deepEqual(seen.map(s=>s.url),[endpoint,endpoint]);
  assert.deepEqual(seen.map(s=>s.system).sort(),[RISK_PROMPT,ROLE_PROMPT].sort());
  for(const {user} of seen)for(const n of [1,2,3,99])assert.ok(!user.toLowerCase().includes(address(n)),address(n));
});
test('the provider binds outputs to the evidence contract version, not a literal',async()=>{
  const args=setup(),{frame,evidence,addresses}=buildReviewInput(args),outputs:{schemaVersion:string}[]=[];
  const deps=openAIPaperCommittee({apiKey:'k',model,fetcher:fakeProvider([])},{clock:()=>NOW+1000,agentTimeoutMs:5000,assess:()=>{throw new Error('not reached');},
    audit:async(_,__,rows)=>rows.map((row,i)=>{outputs.push(row as {schemaVersion:string});return '0x'+String(outputs.length+i).padStart(64,'0');})});
  await runCommitteeReview(frame,args.policy,addresses,evidence,NOW+1000,deps);
  assert.ok(outputs.length===2&&outputs.every(o=>o.schemaVersion===frame.schemaVersion));
  assert.throws(()=>openAIPaperCommittee({apiKey:'k',model,endpoint:'not a url'},{clock:()=>0,agentTimeoutMs:1,assess:()=>{throw new Error();},audit:async()=>[]}),/invalid paper model configuration/);
});
test('both provider schemas accept all 40 finalist rows including candidate 39',async()=>{
  const args=setup(Array(40).fill(45));
  args.score.pairs=Array.from({length:40},(_,a)=>Array.from({length:39-a},(_,offset)=>({a,b:a+offset+1,correlation:0.2,linkedSource:false}))).flat();
  const {frame,evidence,addresses}=buildReviewInput(args),seen:{url:string;system:string;user:string}[]=[];
  for(const selectedModel of ['gpt-6-sol','kimi-k3']){
    const deps=(selectedModel==='kimi-k3'?kimiPaperCommittee:openAIPaperCommittee)({apiKey:'local-test-key',model:selectedModel,fetcher:fakeProvider(seen)},
      {clock:()=>NOW+1000,agentTimeoutMs:5000,assess:()=>{throw new Error('not reached');},audit:async(_,__,rows)=>rows.map((__,i)=>'0x'+String(i+1).padStart(64,'0'))});
    const receipt=await runCommitteeReview(frame,args.policy,addresses,evidence,NOW+1000,deps);
    assert.equal(receipt.manifest.reason,'INSUFFICIENT_EVIDENCE');
  }
  assert.equal(seen.length,4);
  for(const {user} of seen){const payload=JSON.parse(user);assert.equal(payload.evidence.finalists.length,40);assert.equal(payload.evidence.finalists[39].candidate,39);}
});

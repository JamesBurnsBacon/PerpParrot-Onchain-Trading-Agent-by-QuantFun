import {z} from 'zod';
import role from '../schemas/role-consensus.schema.json' with {type:'json'};
import risk from '../schemas/risk-consensus.schema.json' with {type:'json'};
import {commitment} from './commitments.ts';
import {ROLE_PROMPT,RISK_PROMPT,promptHash} from './prompts.ts';
import type {CommitteeEvidence} from './committee-evidence.ts';
import type {Frame,Observation,Row} from './contracts.ts';
/** Role/Risk model adapters (README §4.6, PRODUCTION_INTEGRATION gate 1): one independent model call per
 * node over the bound anonymous committee evidence, strictly parsed into the workflow's Observation.
 * The workflow enforces quorum, binding and the consensus schemas; a failed node is simply absent. */
export type Specialist='role'|'risk';
const fieldsOf=(schema:{properties:{results:{items:{properties:Record<string,unknown>}}}})=>Object.keys(schema.properties.results.items.properties).filter(key=>key!=='candidate');
/** Output fields, read from the consensus schemas so the adapter cannot drift from them. */
export const SPECIALIST_FIELDS:Record<Specialist,string[]>={role:fieldsOf(role),risk:fieldsOf(risk)};
export const SPECIALIST_PROMPTS:Record<Specialist,string>={role:ROLE_PROMPT,risk:RISK_PROMPT};
export interface ModelConfig {provider:'openai';model:string;temperature:0;maxCompletionTokens:number}
export const modelConfigHash=(config:ModelConfig):string=>commitment('perpparrot:model-config:v1',config);
/** Sends a request body and returns the provider's raw response bytes. */
export type ModelCall=(body:object,signal:AbortSignal)=>Promise<Uint8Array>;
const MAX_RESPONSE_BYTES=250_000;
function ensure(ok:boolean,reason:string):asserts ok {if(!ok)throw new Error(reason);}
/** Chat Completions request: the specialist prompt as system, the committee evidence as the user payload,
 * and a strict JSON schema with one integer 0–100 row per candidate. */
export function specialistRequest(kind:Specialist,evidence:CommitteeEvidence,config:ModelConfig):object {
  const ids=evidence.finalists.map(f=>f.candidate);
  const fields=Object.fromEntries(SPECIALIST_FIELDS[kind].map(field=>[field,{type:'integer',minimum:0,maximum:100}]));
  const row={type:'object',additionalProperties:false,properties:{candidate:{type:'integer',enum:ids},...fields},required:['candidate',...SPECIALIST_FIELDS[kind]]};
  return {
    model:config.model,
    messages:[{role:'system',content:SPECIALIST_PROMPTS[kind]},{role:'user',content:JSON.stringify(evidence)}],
    response_format:{type:'json_schema',json_schema:{name:`perpparrot_${kind}`,strict:true,schema:{type:'object',additionalProperties:false,properties:{results:{type:'array',minItems:ids.length,maxItems:ids.length,items:row}},required:['results']}}},
    max_completion_tokens:config.maxCompletionTokens,temperature:config.temperature,store:false,
  };
}
/** Provider envelope is permissive; the rows are strict: every candidate exactly once, integers 0–100. */
export function parseSpecialist(kind:Specialist,body:Uint8Array,candidates:number[]):Row[] {
  ensure(body.length<=MAX_RESPONSE_BYTES,'provider response exceeds budget');
  let envelope:unknown;
  try{envelope=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(body));}catch{throw new Error('invalid provider JSON');}
  const parsed=z.object({choices:z.array(z.object({finish_reason:z.literal('stop'),message:z.object({refusal:z.string().nullable().optional(),content:z.string()})})).length(1)}).safeParse(envelope);
  ensure(parsed.success&&!parsed.data.choices[0]!.message.refusal,'provider refusal/incomplete response');
  let content:unknown;
  try{content=JSON.parse(parsed.data.choices[0]!.message.content);}catch{throw new Error('invalid model JSON');}
  const score=z.number().int().min(0).max(100);
  const rowSchema=z.object({candidate:z.number().int().min(0).max(24),...Object.fromEntries(SPECIALIST_FIELDS[kind].map(field=>[field,score]))}).strict();
  const result=z.object({results:z.array(rowSchema).length(candidates.length)}).strict().safeParse(content);
  ensure(result.success,'invalid model output schema');
  const rows=[...result.data.results].sort((a,b)=>a.candidate-b.candidate);
  const expected=[...candidates].sort((a,b)=>a-b);
  ensure(rows.every((row,i)=>row.candidate===expected[i]),'model candidate mismatch');
  return rows as Row[];
}
/** A workflow dependency (`role` or `risk`): calls the model once per node and returns the observations
 * that parsed. The evidence must be bound to the very frame the workflow passes in. */
export function createSpecialist(options:{kind:Specialist;evidence:CommitteeEvidence;config:ModelConfig;nodeIds:readonly string[];call:ModelCall;onError?:(nodeId:string,error:Error)=>void}):(frame:Frame,signal:AbortSignal)=>Promise<Observation[]> {
  const {kind,evidence,config,call}=options,nodeIds=[...options.nodeIds];
  const prompt=SPECIALIST_PROMPTS[kind],hashes={promptHash:promptHash(prompt),modelConfigHash:modelConfigHash(config)};
  const candidates=evidence.finalists.map(f=>f.candidate);
  return async(frame,signal)=>{
    ensure(frame.schemaVersion===evidence.schemaVersion&&frame.snapshotHash===evidence.snapshotHash&&frame.policyHash===evidence.policyHash&&frame.asOfMs===evidence.asOfMs
      &&frame.candidates.map(c=>c.candidate).join()===candidates.join(),'specialist evidence is not bound to this frame');
    const body=specialistRequest(kind,evidence,config);
    const settled=await Promise.allSettled(nodeIds.map(async(nodeId):Promise<Observation>=>({
      nodeId,schemaVersion:frame.schemaVersion,snapshotHash:frame.snapshotHash,policyHash:frame.policyHash,...hashes,
      results:parseSpecialist(kind,await call(body,signal),candidates),
    })));
    settled.forEach((outcome,i)=>{if(outcome.status==='rejected')options.onError?.(nodeIds[i]!,outcome.reason instanceof Error?outcome.reason:new Error(String(outcome.reason)));});
    return settled.flatMap(outcome=>outcome.status==='fulfilled'?[outcome.value]:[]);
  };
}
/** OpenAI Chat Completions over fetch. The key goes only into the Authorization header; errors carry the
 * HTTP status, never the request or the key. */
export function openAIChat(apiKey:string,options:{fetch?:typeof fetch;endpoint?:string}={}):ModelCall {
  ensure(apiKey.length>0,'missing model API key');
  const send=options.fetch??fetch,endpoint=options.endpoint??'https://api.openai.com/v1/chat/completions';
  return async(body,signal)=>{
    const response=await send(endpoint,{method:'POST',headers:{'Content-Type':'application/json',Authorization:`Bearer ${apiKey}`},body:JSON.stringify(body),signal});
    if(!response.ok)throw new Error(`provider HTTP ${response.status}`);
    const bytes=new Uint8Array(await response.arrayBuffer());
    ensure(bytes.length<=MAX_RESPONSE_BYTES,'provider response exceeds budget');
    return bytes;
  };
}

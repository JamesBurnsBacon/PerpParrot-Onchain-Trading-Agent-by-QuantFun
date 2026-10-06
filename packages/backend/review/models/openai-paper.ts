// @env node
import {z} from '../../../shared/src/zod.ts';
import roleSchema from '../../../shared/schemas/role-consensus.schema.json' with {type:'json'};
import riskSchema from '../../../shared/schemas/risk-consensus.schema.json' with {type:'json'};
import redSchema from '../../../shared/schemas/redteam-consensus.schema.json' with {type:'json'};
import {postJson} from '../../../shared/src/bounded-http.ts';
import {validate} from '../../../shared/src/validate.ts';
import {commitment} from '../../../shared/src/commitments.ts';
import {ROLE_PROMPT,RISK_PROMPT,RED_TEAM_PROMPT} from '../../../shared/src/prompts.ts';
import type {CommitteeEvidence} from '../../../shared/src/committee-evidence.ts';
import type {CommitteeDependencies,EvidenceObservation,EvidenceCritique,CritiqueInput} from '../../../cre-workflows/review/committee/types.ts';
import type {PaperModelOptions,PaperModelCore,CommitteeStage} from './types.ts';
const modelPattern=/^gpt-[A-Za-z0-9.-]+-\d{4}-\d{2}-\d{2}$/;
const nodeId='paper-provider';
/** Real server-side provider adapter, one local observation. It never impersonates
 * DON nodes; deployed CRE must perform independent capability consensus. */
export function openAIPaperCommittee(options:PaperModelOptions,core:PaperModelCore):CommitteeDependencies{
  // Default: the versioned prompts, byte-identical to docs/agents/SYSTEM_PROMPTS.md.
  const {apiKey,model}=options,prompts={...(options.prompts??{role:ROLE_PROMPT,risk:RISK_PROMPT,redteam:RED_TEAM_PROMPT})},fetcher=options.fetcher??fetch;
  const endpoint=options.endpoint??'https://api.openai.com/v1/chat/completions';
  if(!apiKey||apiKey.length>2048||/[\r\n]/.test(apiKey)||!modelPattern.test(model)||!/^https?:\/\/[^\s]+$/.test(endpoint)||Object.values(prompts).some(value=>!value||value.length>10000))throw new Error('invalid paper model configuration');
  const promptHashes=Object.fromEntries(Object.entries(prompts).map(([stage,prompt])=>[stage,commitment('perpparrot:prompt:v1',prompt)])) as Record<CommitteeStage,string>;
  const modelConfigHash=commitment('perpparrot:model:v1',{provider:'openai',model,temperature:0,promptHashes});
  const request=async(stage:CommitteeStage,evidence:CommitteeEvidence,signal:AbortSignal,draft?:CritiqueInput):Promise<EvidenceObservation|EvidenceCritique>=>{
    const saved=structuredClone(evidence),{evidenceHash,...payload}=saved;
    if(evidenceHash!==commitment('perpparrot:committee-evidence:v1',payload))throw new Error('invalid paper model evidence');
    const ids=(draft?draft.sources:saved.finalists).map(row=>row.candidate).sort((a,b)=>a-b);
    const row=structuredClone(stage==='role'?roleSchema.properties.results:stage==='risk'?riskSchema.properties.results:redSchema.properties.penalties);
    row.minItems=ids.length;row.maxItems=ids.length;
    // Enum narrows provider candidate identities; independent validation repeats it.
    Object.assign(row.items.properties.candidate,{enum:ids});
    const properties=stage==='redteam'?{rebuildScore:redSchema.properties.rebuildScore,portfolioRisk:redSchema.properties.portfolioRisk,penalties:row}:{results:row};
    const user={evidence:saved,...(draft?{draft:{draftHash:draft.draftHash,policy:draft.policy,sources:draft.sources,cashWeight:draft.cashWeight}}:{})};
    const body={model,messages:[{role:'system',content:prompts[stage]},{role:'user',content:JSON.stringify(user)}],temperature:0,store:false,max_completion_tokens:8192,
      response_format:{type:'json_schema',json_schema:{name:`paper_${stage}`,strict:true,schema:{type:'object',additionalProperties:false,properties,required:Object.keys(properties)}}}};
    if(new TextEncoder().encode(JSON.stringify(body)).length>115000)throw new Error('paper model request exceeds budget');
    const value=await postJson(endpoint,body,{Authorization:`Bearer ${apiKey}`},signal,fetcher);
    const envelope=z.object({model:z.literal(model),choices:z.array(z.object({finish_reason:z.literal('stop'),message:z.object({content:z.string().max(200000),refusal:z.string().nullable().optional()})})).length(1)}).parse(value);
    if(envelope.choices[0].message.refusal)throw new Error('model refusal');
    const output:unknown=JSON.parse(envelope.choices[0].message.content);
    const fields=z.record(z.string(),z.unknown()).parse(output);
    const expected=stage==='redteam'?['penalties','portfolioRisk','rebuildScore']:['results'];
    if(Object.keys(fields).sort().join(',')!==expected.sort().join(','))throw new Error('unknown model output fields');
    // The contract version of the bound evidence (and so of its frame), never a hard-coded literal.
    const binding={schemaVersion:saved.schemaVersion,snapshotHash:saved.snapshotHash,policyHash:saved.policyHash,promptHash:promptHashes[stage],modelConfigHash};
    const native={...binding,...fields,...(draft?{draftHash:draft.draftHash}:{}),quorum:1};
    validate(`${stage}-consensus`,native);
    const observed=(fields[stage==='redteam'?'penalties':'results'] as {candidate:number}[]).map(row=>row.candidate).sort((a,b)=>a-b);
    if(observed.length!==ids.length||observed.some((id,index)=>id!==ids[index]))throw new Error('paper model candidate mismatch');
    const {quorum,...validated}=native;
    return {...validated,nodeId,evidenceHash} as EvidenceObservation|EvidenceCritique;
  };
  return {...core,nodeIds:[nodeId],quorum:1,rolePromptHash:promptHashes.role,riskPromptHash:promptHashes.risk,redTeamPromptHash:promptHashes.redteam,modelConfigHash,
    role:async(evidence,signal)=>[await request('role',evidence,signal) as EvidenceObservation],
    risk:async(evidence,signal)=>[await request('risk',evidence,signal) as EvidenceObservation],
    redTeam:async(input,signal)=>[await request('redteam',input.evidence,signal,input) as EvidenceCritique],
  };
}

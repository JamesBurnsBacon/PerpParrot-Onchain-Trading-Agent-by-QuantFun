// Offline integrity verification for the published two-model Role/Risk-only run.
// No model/network calls. HTTP status is runner metadata, not a provider signature.
import {readFileSync,writeFileSync,existsSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {parseArgs} from 'node:util';
import {isDeepStrictEqual} from 'node:util';
import {commitment} from '../packages/shared/src/commitments.ts';
import {bindCommitteeEvidence} from '../packages/shared/src/committee-evidence.ts';
import {validateCommitteeReceipt} from '../packages/backend/review/committee/workflow.ts';
import {validate} from '../packages/shared/src/validate.ts';
import {ROLE_PROMPT,RISK_PROMPT,RED_TEAM_PROMPT,PROMPT_VERSION} from '../packages/shared/src/prompts.ts';
import type {CommitteeReceipt} from '../packages/backend/review/committee/types.ts';
import type {Frame,Policy,Row} from '../packages/shared/src/contracts.ts';

const models=['gpt-4.1-mini-2025-04-14','gpt-4.1-2025-04-14'] as const;
const prompts={role:ROLE_PROMPT,risk:RISK_PROMPT,redteam:RED_TEAM_PROMPT};
const promptHashes=Object.fromEntries(Object.entries(prompts).map(([stage,prompt])=>[stage,commitment('perpparrot:prompt:v1',prompt)]));
function ensure(condition:unknown,code:string):asserts condition{if(!condition)throw Error('VERIFY_PROVIDER:'+code);}
const objectKeys=(value:Record<string,unknown>,expected:string[])=>isDeepStrictEqual(Object.keys(value).sort(),[...expected].sort());
const integer=(value:unknown):value is number=>typeof value==='number'&&Number.isSafeInteger(value)&&value>=0;
const load=(path:string)=>JSON.parse(readFileSync(path,'utf8'));

export function verifyProviderResults(inputPath:string,resultsPath:string){
 const raw=readFileSync(inputPath),inputSha256=createHash('sha256').update(raw).digest('hex');
 const input=JSON.parse(raw.toString('utf8')) as {schema:string;sourceKind:string;economicAuthority:boolean;asOfMs:number;frame:Frame;policy:Policy;evidence:unknown;addresses:[number,string][]};
 const summary=load(join(resultsPath,'summary.json'));
 ensure(summary.schemaVersion==='measured-provider-probe.v1'&&summary.inputSha256===inputSha256,'INPUT_SHA256_OR_SUMMARY_SCHEMA');
 ensure(input.schema==='measured-review-input.v1'&&input.sourceKind==='REAL_PUBLIC_API'&&input.economicAuthority===false&&input.asOfMs===input.frame.asOfMs,'INPUT_SCOPE');
 const evidence=bindCommitteeEvidence(input.frame,input.policy,new Map(input.addresses),input.evidence);
 ensure(summary.frameHash===input.frame.snapshotHash&&summary.evidenceHash===evidence.evidenceHash&&summary.promptVersion===PROMPT_VERSION,'EVIDENCE_OR_PROMPT_VERSION');
 ensure(summary.sourceKind==='REAL_PUBLIC_API'&&summary.economicAuthority===false&&summary.liveOrdersSubmitted===0&&summary.retries===0&&summary.callsAllowed===6&&summary.totalCalls===4&&summary.transportAndSchemaValidated===true,'RUN_SCOPE');
 ensure(integer(summary.startedAtMs)&&integer(summary.completedAtMs)&&summary.completedAtMs>=summary.startedAtMs,'RUN_CLOCK');
 ensure(Array.isArray(summary.calls)&&summary.calls.length===4&&Array.isArray(summary.models)&&summary.models.length===2,'RUN_CARDINALITY');
 const ids=input.frame.candidates.map(c=>c.candidate).sort((a,b)=>a-b),verified=[];
 const allRecordIds=new Set<string>();
 for(const model of models){
  const modelRows=summary.models.filter((m:any)=>m.model===model);ensure(modelRows.length===1,'MODEL_IDENTITY');const modelSummary=modelRows[0];
  const calls=summary.calls.filter((c:any)=>c.model===model);
  ensure(calls.length===2&&['role','risk'].every(stage=>calls.filter((c:any)=>c.stage===stage).length===1),'STAGE_CALL_CARDINALITY');
  ensure(integer(modelSummary.startedAtMs)&&integer(modelSummary.completedAtMs)&&modelSummary.startedAtMs>=summary.startedAtMs&&modelSummary.completedAtMs<=summary.completedAtMs&&modelSummary.completedAtMs>=modelSummary.startedAtMs,'MODEL_CLOCK');
  for(const call of calls){
   ensure(objectKeys(call,['model','stage','startedAtMs','completedAtMs','transport','responseValidated','httpStatus']),'CALL_FIELDS_OR_PRIVATE_HEADERS');
   ensure(call.transport==='HTTP_RESPONSE'&&call.responseValidated===true&&call.httpStatus===200,'CALL_STATUS');
   ensure(integer(call.startedAtMs)&&integer(call.completedAtMs)&&call.startedAtMs>=modelSummary.startedAtMs&&call.completedAtMs>=call.startedAtMs&&call.completedAtMs<=modelSummary.completedAtMs,'CALL_CLOCK');
  }
  const receipt=load(join(resultsPath,model+'-receipt.json')) as CommitteeReceipt;
  validateCommitteeReceipt(receipt,receipt.manifest.createdAtMs);
  const manifest=receipt.manifest;
  ensure(manifest.snapshotHash===input.frame.snapshotHash&&manifest.policyHash===input.frame.policyHash&&isDeepStrictEqual(manifest.policy,input.policy)&&manifest.schemaVersion===input.frame.schemaVersion,'MANIFEST_INPUT_BINDING');
  ensure(manifest.createdAtMs>=input.frame.asOfMs&&manifest.createdAtMs<input.frame.expiresAtMs&&manifest.createdAtMs-input.frame.asOfMs<=input.policy.maxFrameAgeMs&&manifest.expiresAtMs===input.frame.expiresAtMs&&manifest.createdAtMs>=modelSummary.startedAtMs&&manifest.createdAtMs<=modelSummary.completedAtMs,'MANIFEST_CAPTURE_CLOCK');
  ensure(manifest.status==='INVALID_BUCKET'&&manifest.reason==='INSUFFICIENT_EVIDENCE'&&manifest.sources.length===0&&manifest.cashWeight===1&&receipt.economicAuthority===false,'EXPECTED_ROLE_RISK_ONLY_RESULT');
  ensure(modelSummary.reviewStatus===manifest.status&&modelSummary.reason===manifest.reason&&modelSummary.sourceCount===0&&modelSummary.service===null&&modelSummary.stage==='complete'&&modelSummary.receiptHash===receipt.receiptHash&&modelSummary.auditRows===2&&modelSummary.serviceBlocked==='INSUFFICIENT_EVIDENCE'&&!modelSummary.failure,'MODEL_SUMMARY_MATCH');
  ensure(!existsSync(join(resultsPath,model+'-paper-freeze.json'))&&!existsSync(join(resultsPath,model+'-service.json')),'UNEXPECTED_FREEZE_OR_SERVICE');
  const modelConfigHash=commitment('perpparrot:model:v1',{provider:'openai',model,temperature:0,promptHashes});
  ensure(receipt.modelConfigHash===modelConfigHash&&receipt.evidenceHash===evidence.evidenceHash,'RECEIPT_MODEL_EVIDENCE');
  const audit=load(join(resultsPath,model+'-audit.json'));
  ensure(objectKeys(audit,['promptBodyExported','promptSource','records'])&&audit.promptBodyExported===false&&audit.promptSource==='packages/shared/src/prompts.ts'&&Array.isArray(audit.records)&&audit.records.length===2,'AUDIT_ENVELOPE');
  const recordIds:string[]=[],stages:string[]=[];
  for(const record of audit.records){
   ensure(objectKeys(record,['id','snapshot_hash','prompt_hash','output_hash','model_version','output','created_at_ms']),'AUDIT_FIELDS_OR_PRIVATE_HEADERS');
   const stage=record.output.promptHash===promptHashes.role?'role':record.output.promptHash===promptHashes.risk?'risk':null;
   ensure(stage!==null&&!stages.includes(stage),'AUDIT_STAGE');stages.push(stage);
   validate(`${stage}-consensus`,record.output);
   const output=record.output as {schemaVersion:string;snapshotHash:string;policyHash:string;modelConfigHash:string;quorum:number;results:Row[]};
   ensure(output.schemaVersion===input.frame.schemaVersion&&output.snapshotHash===input.frame.snapshotHash&&output.policyHash===input.frame.policyHash&&output.modelConfigHash===modelConfigHash&&output.quorum===1,'OUTPUT_BINDING');
   ensure(isDeepStrictEqual(output.results.map(r=>r.candidate).sort((a,b)=>a-b),ids),'OUTPUT_CANDIDATE_SET');
   const call=calls.find((c:any)=>c.stage===stage);
   ensure(integer(record.created_at_ms)&&record.created_at_ms>=call.completedAtMs&&record.created_at_ms<=manifest.createdAtMs,'AUDIT_CLOCK');
   const prompt={system:prompts[stage],evidence};
   ensure(record.snapshot_hash===input.frame.snapshotHash&&record.model_version===model+'/paper-provider','AUDIT_MODEL_BINDING');
   ensure(record.prompt_hash===commitment('perpparrot:audit-prompt:v1',prompt),'AUDIT_PROMPT_HASH');
   ensure(record.output_hash===commitment('perpparrot:audit-output:v1',output),'AUDIT_OUTPUT_HASH');
   const fullRecord={snapshot_hash:record.snapshot_hash,prompt_hash:record.prompt_hash,output_hash:record.output_hash,model_version:record.model_version,prompt,output,created_at_ms:record.created_at_ms};
   ensure(record.id===commitment('perpparrot:audit-record:v1',fullRecord)&&!allRecordIds.has(record.id),'AUDIT_RECORD_HASH_OR_DUPLICATE');
   allRecordIds.add(record.id);recordIds.push(record.id);
  }
  ensure(isDeepStrictEqual(recordIds.sort(),[...receipt.auditIds].sort()),'RECEIPT_AUDIT_SET');
  verified.push({model,stages:stages.sort(),auditRecords:recordIds.length,status:manifest.status,reason:manifest.reason,receiptHash:receipt.receiptHash,recordIds});
 }
 ensure(allRecordIds.size===4,'GLOBAL_AUDIT_CARDINALITY');
 return {schema:'provider-verification.v1',verified:true,inputSha256,frameHash:input.frame.snapshotHash,evidenceHash:evidence.evidenceHash,promptVersion:PROMPT_VERSION,
  models:verified,verifiedAuditRecords:4,recordedProviderCalls:4,verifiedStages:['role','risk'],redTeamExecuted:false,freezeExecuted:false,serviceExecuted:false,
  externalCallsDuringVerification:0,liveOrdersSubmitted:0,privacy:'Verifier reconstructs prompts in memory; it exports only hashes and statuses, never raw requests or headers.',
  scope:'Offline input SHA-256, frame/evidence binding, versioned prompts, model configuration, numeric output schemas, audit prompt/output/record hashes and exact receipt audit membership. HTTP200/call count are runner metadata, not provider-signed attestations.'};
}

if(import.meta.main){
 const{values}=parseArgs({options:{input:{type:'string'},results:{type:'string'},out:{type:'string'}}});
 if(!values.input||!values.results)throw Error('usage: verify-provider.ts --input review-input.json --results provider-results [--out verification.json]');
 try{const verified=verifyProviderResults(resolve(values.input),resolve(values.results));const out=resolve(values.out??join(values.results,'verification.json'));
  writeFileSync(out,JSON.stringify(verified,null,2)+'\n');console.log(JSON.stringify({marker:'PROVIDER_EVIDENCE_VERIFIED',records:verified.verifiedAuditRecords,calls:verified.recordedProviderCalls,redTeamExecuted:false,externalCalls:0}));}
 catch(error){console.error(error instanceof Error&&error.message.startsWith('VERIFY_PROVIDER:')?error.message:'VERIFY_PROVIDER:VALIDATION_FAILED');process.exitCode=1;}
}

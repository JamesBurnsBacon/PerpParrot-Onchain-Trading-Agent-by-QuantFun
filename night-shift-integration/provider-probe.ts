// Isolated paid-provider probe. No exchange credentials, production writes, or retry loop.
// The only upstream destination permitted by this program is the fixed model endpoint.
import {PGlite} from '@electric-sql/pglite';
import {mkdirSync,readFileSync,writeFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {parseArgs} from 'node:util';
import {createHash} from 'node:crypto';
import {openAIPaperCommittee} from '../packages/backend/review/models/openai-paper.ts';
import {committeeAudit} from '../packages/backend/review/committee-audit.ts';
import {reviewPaperSession,freezePaperSession} from '../packages/backend/review/paper/lifecycle.ts';
import {SupabasePaperStore} from '../packages/backend/review/paper/store.ts';
import {bindCommitteeEvidence} from '../packages/shared/src/committee-evidence.ts';
import {ROLE_PROMPT,RISK_PROMPT,RED_TEAM_PROMPT,PROMPT_VERSION} from '../packages/shared/src/prompts.ts';
import {validate} from '../packages/shared/src/validate.ts';
import type {Frame,Policy} from '../packages/shared/src/contracts.ts';
import type {Rpc} from '../packages/backend/review/supabase.ts';
import type {FrozenConfiguration} from '../packages/shared/frozen.ts';
import {buildMeasuredAssessment,runMeasuredService,type SourceRead,type MarketResponses} from './measured-service.ts';
import {digest} from './contracts.ts';

export const MODELS=['gpt-4.1-mini-2025-04-14','gpt-4.1-2025-04-14'] as const;
const ENDPOINT='https://api.openai.com/v1/chat/completions';
const save=(path:string,value:unknown)=>writeFileSync(path,JSON.stringify(value,null,2)+'\n');
type Model=typeof MODELS[number];
type Stage='role'|'risk'|'redteam';
export type ProviderCall={model:Model;stage:Stage;startedAtMs:number;completedAtMs?:number;httpStatus?:number;transport:'PENDING'|'HTTP_RESPONSE'|'NETWORK_ERROR';responseValidated:boolean};
export type MeasuredBundle={schema:'measured-review-input.v1';sourceKind:'REAL_PUBLIC_API';economicAuthority:false;asOfMs:number;frame:Frame;policy:Policy;evidence:unknown;addresses:[number,string][];sourceReads:SourceRead[];marketResponses:MarketResponses;provenance:unknown;sourceIngest:unknown};

/** Bounded, endpoint-pinned transport; no response bodies, headers, API keys or raw errors logged. */
export function providerTransport(calls:ProviderCall[],transport:typeof fetch=fetch):typeof fetch{
 return (async(input:Parameters<typeof fetch>[0],init?:RequestInit)=>{
  const url=input instanceof Request?input.url:String(input);
  if(url!==ENDPOINT||init?.method!=='POST'||typeof init.body!=='string')throw Error('PROVIDER_DESTINATION_REJECTED');
  const body=JSON.parse(init.body),model=body.model as Model,name=body.response_format?.json_schema?.name;
  const stage=name==='paper_role'?'role':name==='paper_risk'?'risk':name==='paper_redteam'?'redteam':null;
  if(!MODELS.includes(model)||!stage||calls.length>=6||calls.filter(c=>c.model===model).length>=3||calls.some(c=>c.model===model&&c.stage===stage))throw Error('PROVIDER_CALL_BUDGET_REJECTED');
  const call:ProviderCall={model,stage,startedAtMs:Date.now(),transport:'PENDING',responseValidated:false};calls.push(call);
  try{const response=await transport(ENDPOINT,{...init,redirect:'error'});call.httpStatus=response.status;call.transport='HTTP_RESPONSE';return response;}
  catch{call.transport='NETWORK_ERROR';throw Error('PROVIDER_NETWORK_FAILURE');}
  finally{call.completedAtMs=Date.now();}
 }) as typeof fetch;
}

function checkBundle(bundle:MeasuredBundle,now:number){
 if(bundle.schema!=='measured-review-input.v1'||bundle.sourceKind!=='REAL_PUBLIC_API'||bundle.economicAuthority!==false||bundle.asOfMs!==bundle.frame?.asOfMs)throw Error('INPUT_BINDING_INVALID');
 validate('candidate-curation-frame',bundle.frame);validate('bucket-policy',bundle.policy);
 if(bundle.frame.asOfMs>now||now>=bundle.frame.expiresAtMs||now-bundle.frame.asOfMs>bundle.policy.maxFrameAgeMs)throw Error('INPUT_STALE');
 if(!Number.isSafeInteger(bundle.policy.maxFrameAgeMs)||bundle.policy.maxFrameAgeMs<1||bundle.policy.maxFrameAgeMs>3_600_000)throw Error('INPUT_AGE_BOUND_INVALID');
 if(!Array.isArray(bundle.addresses)||bundle.addresses.length!==bundle.frame.candidates.length||new Map(bundle.addresses).size!==bundle.addresses.length||!Array.isArray(bundle.sourceReads)||bundle.sourceReads.length>25)throw Error('INPUT_SOURCE_SET_INVALID');
 const addresses=new Map(bundle.addresses);
 if([...addresses.values()].some(a=>!bundle.sourceReads.some(r=>r.address===a)))throw Error('INPUT_SOURCE_MISSING');
 return {addresses,evidence:bindCommitteeEvidence(bundle.frame,bundle.policy,addresses,bundle.evidence)};
}
const safeFailure=(error:unknown)=>error instanceof Error&&/^INPUT_[A-Z_]+$/.test(error.message)?error.message:'VALIDATION_OR_SERVICE_FAILURE';

export async function runProviderProbe(input:{bundle:MeasuredBundle;inputSha256:string;outPath:string;apiKey:string}){
 const bundle=structuredClone(input.bundle),startedAtMs=Date.now(),calls:ProviderCall[]=[];
 const output=resolve(input.outPath),privateDir=join(output,'private'),publicDir=join(output,'public');
 mkdirSync(privateDir,{recursive:true});mkdirSync(publicDir,{recursive:true});
 const summary:{[key:string]:unknown;models:Record<string,unknown>[] }={schemaVersion:'measured-provider-probe.v1',sourceKind:'REAL_PUBLIC_API',economicAuthority:false,
  startedAtMs,inputSha256:input.inputSha256,sourceIngest:bundle.sourceIngest,promptVersion:PROMPT_VERSION,models:[],calls,
  callsAllowed:6,retries:0,liveOrdersSubmitted:0,clock:'real Date.now for provider review and expiry checks',
  scope:'Two model committee runs on one current cohort; not four-window model-selection performance validation.'};
 let success=false;
 try{
  summary.preflightStage='provider-key';if(!input.apiKey)throw Error('INPUT_PROVIDER_KEY_MISSING');
  summary.preflightStage='bundle-validation';
  const bound=checkBundle(bundle,Date.now());
  summary.preflightStage='measured-assessment';
  const prepared=await buildMeasuredAssessment({sourceKind:'REAL_PUBLIC_API',sourceReads:bundle.sourceReads,marketResponses:bundle.marketResponses,asOfMs:Date.now(),maxReadAgeMs:bundle.policy.maxFrameAgeMs});
  // Compare captured object hashes, rather than relabel original read times as CI time.
  summary.preflightStage='provenance-verification';
  const original=bundle.provenance as {sourceReads?:unknown;markets?:unknown};
  if(digest(original.sourceReads)!==digest(prepared.provenance.sourceReads)||digest(original.markets)!==digest(prepared.provenance.markets))throw Error('INPUT_PROVENANCE_MISMATCH');
  summary.frameHash=bundle.frame.snapshotHash;summary.evidenceHash=bound.evidence.evidenceHash;
  summary.measurementProvenance=prepared.provenance;
  summary.preflightStage='complete';
  const transport=providerTransport(calls),prompts={role:ROLE_PROMPT,risk:RISK_PROMPT,redteam:RED_TEAM_PROMPT};
  for(const model of MODELS){
   const modelDir=join(privateDir,model);mkdirSync(modelDir,{recursive:true});
   const db=new PGlite(join(modelDir,'postgres'));
   const result:Record<string,unknown>={model,startedAtMs:Date.now(),reviewStatus:null,reason:null,sourceCount:0,service:null,stage:'database-setup'};summary.models.push(result);
   try{
    checkBundle(bundle,Date.now());
    await db.exec('create role anon; create role authenticated; create role service_role bypassrls;');
    for(const file of ['20261006130000_review_audit.sql','20261006140000_paper_review.sql'])await db.exec(readFileSync(new URL('../supabase/migrations/'+file,import.meta.url),'utf8'));
    const rpc:Rpc={async call(name,args){if(!/^[a-z_]+$/.test(name)||Object.keys(args).some(k=>!/^[a-z_]+$/.test(k)))throw Error('INVALID_RPC');
     return(await db.query<{value:unknown}>(`select ${name}(${Object.keys(args).map((k,i)=>`${k} => $${i+1}`).join(',')}) as value`,Object.values(args).map(v=>typeof v==='object'?JSON.stringify(v):v))).rows[0].value;}};
    const persist=committeeAudit(rpc,model,prompts,Date.now);
    const deps=openAIPaperCommittee({apiKey:input.apiKey,model,fetcher:transport},{clock:Date.now,agentTimeoutMs:60_000,assess:prepared.assess,
     audit:async(stage,evidence,rows,draft)=>{const ids=await persist(stage,evidence,rows,draft);const call=calls.find(c=>c.model===model&&c.stage===stage);if(call)call.responseValidated=true;return ids;}});
    const store=new SupabasePaperStore(rpc),session='provider:'+model+':'+bundle.frame.snapshotHash;
    result.stage='committee';
    const review=await reviewPaperSession({session,frame:bundle.frame,policy:bundle.policy,addresses:bound.addresses,rich:bundle.evidence,nowMs:Date.now()},store,deps,async()=>{throw Error('UNEXPECTED_MONITOR');});
    if(review.phase!=='REVIEW')throw Error('UNEXPECTED_PHASE');
    const receipt=review.receipt;Object.assign(result,{reviewStatus:receipt.manifest.status,reason:receipt.manifest.reason,sourceCount:receipt.manifest.sources.length,receiptHash:receipt.receiptHash,auditRows:receipt.auditIds.length});
    save(join(publicDir,model+'-receipt.json'),receipt);
    if(receipt.manifest.status==='VALID'&&receipt.manifest.sources.length>=5){
     result.stage='paper-freeze';
     const configuration=await freezePaperSession(store,session,receipt.receiptHash,'0x0000000000000000000000000000000000000001',999,Date.now());
     save(join(publicDir,model+'-paper-freeze.json'),configuration);
     result.stage='service-replay';
     result.service=await runMeasuredService({sourceKind:'REAL_PUBLIC_API',outPath:join(modelDir,'service'),configuration:configuration as unknown as FrozenConfiguration,
      sourceReads:bundle.sourceReads.filter(r=>configuration.sources.some(s=>s.sourceAddress===r.address)),marketResponses:bundle.marketResponses,asOfMs:Date.now(),maxReadAgeMs:bundle.policy.maxFrameAgeMs});
     save(join(publicDir,model+'-service.json'),result.service);
    }else result.serviceBlocked=receipt.manifest.status==='VALID'?'FREEZE_REQUIRES_AT_LEAST_FIVE_SOURCES':receipt.manifest.reason;
    result.stage='complete';
   }catch(error){result.failure=safeFailure(error);}
   finally{
    result.completedAtMs=Date.now();
    // Full bound prompt/evidence is persisted in private PGlite; exported audit omits prompt body.
    // Retaining actual consensus numeric output and hashes supports provider provenance without raw requests.
    try{const rows=(await db.query('select id,snapshot_hash,prompt_hash,output_hash,model_version,output,created_at_ms from review_audit order by created_at_ms,id')).rows;
     save(join(publicDir,model+'-audit.json'),{promptBodyExported:false,promptSource:'packages/shared/src/prompts.ts',records:rows});}catch{}
    await db.close();save(join(publicDir,'summary.json'),summary);
   }
  }
  success=summary.models.length===2&&summary.models.every(m=>m.failure===undefined)&&calls.every(c=>c.responseValidated);
 }catch(error){summary.preflightFailure=safeFailure(error);}
 summary.completedAtMs=Date.now();summary.transportAndSchemaValidated=success;
 summary.totalCalls=calls.length;summary.billableCallsMayIncludeFailedResponses=calls.length>0;
 summary.auditScope='Original bound prompt and validated numeric output persisted in private PGlite. Export contains output and commitments, not raw provider requests or credentials.';
 save(join(publicDir,'summary.json'),summary);return {success,summary};
}

if(import.meta.main){
 const {values}=parseArgs({options:{input:{type:'string'},out:{type:'string',default:'night-shift-integration/out/provider'}}});
 if(!values.input)throw Error('usage: provider-probe.ts --input <verified review-input.json> [--out directory]');
 try{const bytes=readFileSync(values.input);if(bytes.length>32*1024*1024)throw Error('INPUT_SIZE_LIMIT');
  const inputSha256=createHash('sha256').update(bytes).digest('hex');
  const result=await runProviderProbe({bundle:JSON.parse(bytes.toString('utf8')),inputSha256,outPath:values.out!,apiKey:process.env.OPENAI_API_KEY??''});
  console.log(JSON.stringify({marker:'MEASURED_PROVIDER_COMPLETE',success:result.success,calls:result.summary.totalCalls,output:join(resolve(values.out!),'public')}));
  if(!result.success)process.exitCode=1;
 }catch{console.error('MEASURED_PROVIDER_INPUT_OR_SETUP_FAILURE');process.exitCode=1;}
}

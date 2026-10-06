// Request construction only. The injected transport rejects locally; no network or model outputs.
import {readFileSync,writeFileSync} from 'node:fs';
import {parseArgs} from 'node:util';
import {createHash} from 'node:crypto';
import {openAIPaperCommittee} from '../packages/backend/review/models/openai-paper.ts';
import {bindCommitteeEvidence} from '../packages/shared/src/committee-evidence.ts';
import {commitment} from '../packages/shared/src/commitments.ts';
import {validateEvidence} from '../packages/shared/src/review-evidence.ts';
import {MODELS,type MeasuredBundle} from './provider-probe.ts';

export async function preflightProviderRequests(bundle:Pick<MeasuredBundle,'frame'|'policy'|'addresses'|'evidence'>){
 const evidence=bindCommitteeEvidence(bundle.frame,bundle.policy,new Map(bundle.addresses),bundle.evidence);
 const requests:{model:string;stage:string;bytes:number;modelInputAnonymous:boolean}[]=[];
 const weight=Math.min(bundle.policy.maxSourceWeight,(1-bundle.policy.cashBuffer)/bundle.frame.candidates.length);
 const sources=bundle.frame.candidates.map(c=>({candidate:c.candidate,weight,maxAllocation:bundle.policy.maxSourceWeight}));
 const cashWeight=1-sources.reduce((n,s)=>n+s.weight,0);
 const draftHash=commitment('perpparrot:draft:v1',{schemaVersion:bundle.frame.schemaVersion,snapshotHash:bundle.frame.snapshotHash,policyHash:bundle.frame.policyHash,policy:bundle.policy,sources,cashWeight});
 for(const model of MODELS){
  const fetcher=(async(_input:unknown,init?:RequestInit)=>{
   const raw=String(init?.body),body=JSON.parse(raw),user=body.messages[1].content as string;
   requests.push({model,stage:body.response_format.json_schema.name,bytes:new TextEncoder().encode(raw).length,
    modelInputAnonymous:bundle.addresses.every(([,address])=>!user.toLowerCase().includes(address.toLowerCase()))});
   return new Response('',{status:503});
  }) as unknown as typeof fetch;
  const deps=openAIPaperCommittee({apiKey:'local-dummy-not-a-credential',model,fetcher},{clock:Date.now,agentTimeoutMs:60000,
   assess:()=>{throw Error('not an assessment run');},audit:async()=>{throw Error('no provider output to audit');}});
  for(const invoke of [()=>deps.role(evidence,new AbortController().signal),()=>deps.risk(evidence,new AbortController().signal),
   ()=>deps.redTeam({frame:bundle.frame,policy:bundle.policy,evidence,draftHash,sources,cashWeight},new AbortController().signal)]){
   try{await invoke();throw Error('unexpected provider success');}catch(error){if(!(error instanceof Error)||error.message!=='upstream request failed')throw error;}
  }
 }
 if(requests.length!==6||requests.some(r=>r.bytes>115000||!r.modelInputAnonymous))throw Error('PROVIDER_REQUEST_PREFLIGHT_FAILED');
 return {schema:'provider-request-preflight.v1',frameHash:bundle.frame.snapshotHash,evidenceHash:evidence.evidenceHash,finalists:bundle.frame.candidates.length,
  requests,externalProviderCalls:0,reviewReceiptsProduced:0,economicAuthority:false,
  scope:'Production request construction over the supplied evidence. Local dummy HTTP503 responses only. Red-Team uses a synthetic maximum-candidate draft solely to test request capacity; it is not a selected portfolio.'};
}

/** Reduce presentation only until the real adapter can encode all three stages within its fixed budget. */
export async function compactProviderEvidence(bundle:Pick<MeasuredBundle,'frame'|'policy'|'addresses'|'evidence'>){
 const evidence=structuredClone(validateEvidence(bundle.evidence));
 const curves=new Map(evidence.finalists.map(f=>[f.candidate,[...f.equityCurve]]));
 const before={curvePoints:evidence.finalists.reduce((n,f)=>n+f.equityCurve.length,0),positions:evidence.finalists.reduce((n,f)=>n+f.positions.length,0)};
 for(let attempt=0;attempt<1000;attempt++){
  try{
   const preflight=await preflightProviderRequests({...bundle,evidence});
   // A real committee can emit different floating-point weights/ceilings than the capacity draft.
   // Reserve extra encoding room without changing the production adapter's 115 KB ceiling.
   if(preflight.requests.some(r=>r.bytes>115000-2048))throw Error('PROVIDER_DRAFT_BUDGET_MARGIN');
   return {evidence,committee:bindCommitteeEvidence(bundle.frame,bundle.policy,new Map(bundle.addresses),evidence),preflight,
    presentation:{method:'Evenly thin displayed curves, retaining both endpoints and >=26 points; then remove smallest displayed positions. Metrics, policy and raw measurements unchanged.',
     requestBudgetBytes:115000,reservedDraftBytes:2048,before,after:{curvePoints:evidence.finalists.reduce((n,f)=>n+f.equityCurve.length,0),positions:evidence.finalists.reduce((n,f)=>n+f.positions.length,0)}}};
  }catch(error){
   if(!(error instanceof Error)||!['paper model request exceeds budget','committee payload exceeds reserved request budget','combined finalist exceeds 4 KB','PROVIDER_DRAFT_BUDGET_MARGIN'].includes(error.message))throw error;
   const curve=[...evidence.finalists].filter(f=>f.equityCurve.length>26).sort((a,b)=>b.equityCurve.length-a.equityCurve.length||a.candidate-b.candidate)[0];
   if(curve){const original=curves.get(curve.candidate)!,count=curve.equityCurve.length-1;
    curve.equityCurve=Array.from({length:count},(_,i)=>original[Math.round(i*(original.length-1)/(count-1))]!);continue;}
   // After curves reach their contract minimum, preserve the largest available displayed positions.
   const position=[...evidence.finalists].filter(f=>f.positions.length).map(f=>({f,index:f.positions.reduce((best,p,i)=>Math.abs(p.signedNotionalUsd)<Math.abs(f.positions[best].signedNotionalUsd)?i:best,0)}))
    .sort((a,b)=>Math.abs(a.f.positions[a.index].signedNotionalUsd)-Math.abs(b.f.positions[b.index].signedNotionalUsd)||a.f.candidate-b.f.candidate)[0];
   if(position){position.f.positions.splice(position.index,1);continue;}
   throw Error('PROVIDER_EVIDENCE_CANNOT_FIT_WITHOUT_DROPPING_REQUIRED_DATA');
  }
 }
 throw Error('PROVIDER_COMPACTION_LIMIT');
}
if(import.meta.main){
 const{values}=parseArgs({options:{input:{type:'string'},out:{type:'string'}}});if(!values.input||!values.out)throw Error('usage: --input bundle.json --out preflight.json');
 const raw=readFileSync(values.input),result=await preflightProviderRequests(JSON.parse(raw.toString('utf8')));
 writeFileSync(values.out,JSON.stringify({...result,inputSha256:createHash('sha256').update(raw).digest('hex')},null,2)+'\n');
 console.log(JSON.stringify({marker:'PROVIDER_REQUEST_PREFLIGHT_OK',finalists:result.finalists,requests:result.requests,externalProviderCalls:0}));
}

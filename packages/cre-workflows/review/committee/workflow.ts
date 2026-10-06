// @env node
import {runReview} from '../workflow.ts';
import {bindCommitteeEvidence} from '../../../shared/src/committee-evidence.ts';
import {commitment} from '../../../shared/src/commitments.ts';
import {validate} from '../../../shared/src/validate.ts';
import {validateManifest} from '../../../shared/src/authorization.ts';
import type {Frame,Policy} from '../../../shared/src/contracts.ts';
import type {CommitteeDependencies,CommitteeReceipt,EvidenceObservation,EvidenceCritique,CritiqueInput} from './types.ts';

/** Server/paper orchestration. Actual providers must echo the evidence commitment;
 * it is validated before stripping the extension for the existing v1 core. */
export async function runCommitteeReview(frame:Frame,policy:Policy,addresses:ReadonlyMap<number,string>,rich:unknown,nowMs:number,deps:CommitteeDependencies):Promise<CommitteeReceipt> {
  const savedFrame=structuredClone(frame),savedPolicy=structuredClone(policy),savedAddresses=new Map(addresses);
  const evidence=bindCommitteeEvidence(savedFrame,savedPolicy,savedAddresses,rich),auditIds:string[]=[];
  const saved={...deps,nodeIds:[...deps.nodeIds]};
  const unwrap=async <T extends EvidenceObservation|EvidenceCritique>(stage:'role'|'risk'|'redteam',rows:T[],signal:AbortSignal,draft?:CritiqueInput):Promise<Omit<T,'evidenceHash'>[]>=>{
    const owned=structuredClone(rows);
    if(signal.aborted||owned.length<saved.quorum||owned.length>saved.nodeIds.length||new Set(owned.map(row=>row.nodeId)).size!==owned.length||owned.some(row=>row.evidenceHash!==evidence.evidenceHash||!saved.nodeIds.includes(row.nodeId)))throw new Error('unbound committee response');
    for(const {nodeId,evidenceHash,...output} of owned)validate(`${stage}-consensus`,{...output,quorum:1});
    const ids=await saved.audit(stage,structuredClone(evidence),structuredClone(owned),draft?structuredClone(draft):undefined);
    if(signal.aborted||ids.length!==owned.length||ids.some(id=>!/^0x[0-9a-f]{64}$/.test(id)))throw new Error('missing committee audit');
    auditIds.push(...ids);
    return owned.map(({evidenceHash,...row})=>row);
  };
  const manifest=await runReview(savedFrame,savedPolicy,savedAddresses,nowMs,{
    ...saved,
    role:async (_,signal)=>unwrap('role',await saved.role(structuredClone(evidence),signal),signal),
    risk:async (_,signal)=>unwrap('risk',await saved.risk(structuredClone(evidence),signal),signal),
    redTeam:async (input,signal)=>{const draft={...input,evidence:structuredClone(evidence)};return unwrap('redteam',await saved.redTeam(structuredClone(draft),signal),signal,draft);},
  });
  const payload={schemaVersion:'1.0.0' as const,mode:'PAPER' as const,economicAuthority:false as const,
    evidenceHash:evidence.evidenceHash,modelConfigHash:saved.modelConfigHash,manifest,auditIds:[...new Set(auditIds)].sort()};
  return {...payload,receiptHash:commitment('perpparrot:committee-receipt:v1',payload)};
}
export function validateCommitteeReceipt(receipt:CommitteeReceipt,nowMs:number):void {
  const {receiptHash,...payload}=receipt;
  if(Object.keys(receipt).sort().join(',')!==['schemaVersion','mode','economicAuthority','evidenceHash','modelConfigHash','manifest','auditIds','receiptHash'].sort().join(',')||receipt.schemaVersion!=='1.0.0'||receipt.mode!=='PAPER'||receipt.economicAuthority!==false||!/^0x[0-9a-f]{64}$/.test(receipt.evidenceHash)||!/^0x[0-9a-f]{64}$/.test(receipt.modelConfigHash)||!Array.isArray(receipt.auditIds)||receipt.auditIds.length>300||receipt.auditIds.some(id=>!/^0x[0-9a-f]{64}$/.test(id))||new Set(receipt.auditIds).size!==receipt.auditIds.length||receipt.receiptHash!==commitment('perpparrot:committee-receipt:v1',payload))throw new Error('invalid committee receipt');
  validateManifest(receipt.manifest,nowMs);
  if(receipt.manifest.status==='VALID'&&receipt.auditIds.length<3)throw new Error('unaudited review');
}

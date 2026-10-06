import {commitment} from '../../shared/src/commitments.ts';
import {validate} from '../../shared/src/validate.ts';
import type {CommitteeEvidence} from '../../shared/src/committee-evidence.ts';
import type {Rpc} from '../../executor/src/supabase-store.ts';
/** Persist prompt content and validated output, never HTTP headers/provider keys.
 * This is server-side audit plumbing; successful persistence is not freeze authority. */
export async function persistCommitteeAudit(rpc:Rpc,stage:'role'|'risk'|'redteam',modelVersion:string,systemPrompt:string,evidence:CommitteeEvidence,output:unknown,nowMs:number):Promise<string> {
  if(!/^[A-Za-z0-9][A-Za-z0-9._/-]{0,100}$/.test(modelVersion)||!systemPrompt||systemPrompt.length>10000||!Number.isSafeInteger(nowMs)||nowMs<evidence.asOfMs)throw new Error('invalid audit identity');
  validate(`${stage}-consensus`,output);
  const binding=output as {snapshotHash:string;policyHash:string;promptHash:string};
  const {evidenceHash,...payload}=evidence;
  if(evidenceHash!==commitment('perpparrot:committee-evidence:v1',payload)||binding.snapshotHash!==evidence.snapshotHash||binding.policyHash!==evidence.policyHash||binding.promptHash!==commitment('perpparrot:prompt:v1',systemPrompt))throw new Error('audit binding mismatch');
  const prompt={system:systemPrompt,evidence},prompt_hash=commitment('perpparrot:audit-prompt:v1',prompt),output_hash=commitment('perpparrot:audit-output:v1',output);
  const record={snapshot_hash:evidence.snapshotHash,prompt_hash,output_hash,model_version:modelVersion,prompt,output:structuredClone(output),created_at_ms:nowMs};
  const id=commitment('perpparrot:audit-record:v1',record);
  await rpc.call('persist_review_audit',{p_record:{id,...record}},AbortSignal.timeout(5000));
  return id;
}

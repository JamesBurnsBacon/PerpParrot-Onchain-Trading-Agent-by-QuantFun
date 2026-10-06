// @env node
import {persistCommitteeAudit} from './audit.ts';
import type {Rpc} from './supabase.ts';
import type {CommitteeDependencies} from './committee/types.ts';

/** Store each node response independently: unrelated node outputs must never be
 * mislabeled as aggregated consensus. quorum=1 denotes one validated observation. */
export function committeeAudit(rpc:Rpc,modelVersion:string,prompts:Record<'role'|'risk'|'redteam',string>,clock:()=>number):CommitteeDependencies['audit'] {
  const saved={...prompts};
  return async (stage,evidence,rows,draft)=>Promise.all(rows.map(async row=>{
    const {nodeId,evidenceHash,...output}=row;
    if(!nodeId||evidenceHash!==evidence.evidenceHash)throw new Error('invalid node audit binding');
    // node identity is bound into the audit model label to retain provenance.
    // The node label is validated below, rather than accepting arbitrary metadata.
    if(!/^[A-Za-z0-9._-]{1,32}$/.test(nodeId))throw new Error('invalid audit node identity');
    return persistCommitteeAudit(rpc,stage,`${modelVersion}/${nodeId}`,saved[stage],evidence,{...output,quorum:1},clock(),draft);
  }));
}

import type {Manifest} from './contracts.ts';
import {validate} from './validate.ts';
import {commitment,policyCommitment} from './commitments.ts';
function ensure(ok: boolean, message: string): asserts ok {if(!ok)throw new Error(message);}
/** Semantic validation for persisted manifests; JSON Schema alone is not authorization. */
export function validateManifest(value: unknown, nowMs: number): asserts value is Manifest {
  validate('bucket-manifest',value);
  const manifest=value as Manifest;
  ensure(Number.isSafeInteger(nowMs) && nowMs>=0,'invalid clock');
  const {manifestHash,...payload}=manifest;
  ensure(manifestHash===commitment('perpparrot:manifest:v1',payload),'manifest commitment mismatch');
  ensure(manifest.policyHash===policyCommitment(manifest.policy),'policy commitment mismatch');
  ensure(manifest.bucket===manifest.policy.bucket && manifest.mode===manifest.policy.mode,'nested policy mismatch');
  ensure(manifest.mode!=='LIVE' || manifest.bucket==='AGGRESSIVE','unsupported live bucket');
  const sum=manifest.sources.reduce((total,s)=>total+s.weight,0);
  ensure(Math.abs(sum+manifest.cashWeight-1)<=1e-9,'invalid capital total');
  ensure(new Set(manifest.sources.map(s=>s.candidate)).size===manifest.sources.length && new Set(manifest.sources.map(s=>s.sourceAddress)).size===manifest.sources.length,'duplicate source');
  ensure(manifest.sources.every(s=>s.weight>0 && s.weight<=s.maxAllocation && s.maxAllocation<=manifest.policy.maxSourceWeight),'allocation exceeds ceiling');
  if(manifest.status==='INVALID_BUCKET') {
    ensure(manifest.reason!=='OK' && manifest.sources.length===0 && manifest.cashWeight===1,'invalid bucket carries allocation');
    return; // INVALID_BUCKET is never execution authority, even before expiry.
  }
  ensure(manifest.reason==='OK' && manifest.sources.length>0 && manifest.cashWeight>=manifest.policy.cashBuffer-1e-9,'invalid valid-bucket semantics');
  ensure(manifest.createdAtMs<=nowMs && nowMs<manifest.expiresAtMs && manifest.expiresAtMs>manifest.createdAtMs,'expired/future manifest');
}
export function requireFrozenLiveManifest(value: unknown, nowMs: number, frozenHash: string): Manifest {
  validateManifest(value,nowMs);
  ensure(value.status==='VALID' && value.mode==='LIVE' && value.manifestHash===frozenHash,'manifest is not the frozen live authority');
  return value;
}

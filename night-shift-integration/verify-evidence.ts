import {readFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {parseArgs} from 'node:util';
import {byteDigest,digest,eventSchema,runId} from './contracts.ts';
import {codeIdentity} from './pipeline.ts';
import {probeSchema} from './artifact-contracts.ts';
import {validateCommitteeReceipt} from '../packages/backend/review/committee/workflow.ts';
import {checkFrozenConfiguration} from '../packages/shared/frozen.ts';
import {keccakUtf8} from '../packages/backend/src/snapshot.ts';
import {targetsFromSnapshot} from '../packages/shared/copy.ts';
const {values}=parseArgs({options:{dir:{type:'string',default:'night-shift-integration/evidence'}}});
const dir=resolve(values.dir!),json=(path:string)=>JSON.parse(readFileSync(join(dir,path),'utf8'));
const manifest=json('manifest.json');
for(const f of manifest.files){
 if(typeof f.path!=='string'||f.path.startsWith('/')||f.path.split('/').includes('..'))throw Error('UNSAFE_EVIDENCE_PATH');
 if(byteDigest(readFileSync(join(dir,f.path)))!==f.sha256)throw Error('EVIDENCE_HASH_MISMATCH:'+f.path);
}
const e=json('demo/evidence.json');
eventSchema.parse(e.event);
if(e.receipt.runId!==runId(e.event)||e.event.sourceKind!=='SYNTHETIC_FIXTURE'||e.proofs.length!==2||
   e.receipt.steps.length!==2||e.receipt.steps.map((s:any)=>s.stage).sort().join(',')!=='drawdown-first,return-first'||
   e.proofs.map((p:any)=>p.algorithm).sort().join(',')!=='drawdown-first.v1,return-first.v1')throw Error('INCOMPLETE_DEMO');
if(codeIdentity()!==manifest.codeHash)throw Error('CODE_CHANGED_SINCE_EVIDENCE: check out the recorded code commit or rerun the proof');
if(e.event.codeHash!==manifest.codeHash||e.receipt.status!=='SUCCEEDED'||e.receipt.economicAuthority!==false)throw Error('INVALID_RECEIPT');
if(digest(e.receipt.steps.map((s:any)=>({stage:s.stage,bodyHash:s.bodyHash})))!==e.receipt.artifactChainHash)throw Error('CHAIN_HASH_MISMATCH');
for(const value of e.proofs){
 const p=probeSchema.parse(value),stage=p.algorithm.split('.')[0];
 if(e.receipt.steps.find((s:any)=>s.stage===stage)?.bodyHash!==digest(p))throw Error('PROBE_HASH_MISMATCH');
 const review=json(`controlled/${stage}/review.json`),snapshotBytes=readFileSync(join(dir,`controlled/${stage}/snapshot.json`),'utf8');
 const snapshot=JSON.parse(snapshotBytes),runs=json(`controlled/${stage}/dashboard-runs.json`);
 validateCommitteeReceipt(review.receipt,e.event.bucketMs);
 if(review.sourceKind!=='SYNTHETIC_FIXTURE'||review.economicAuthority!==false||review.receipt.receiptHash!==p.reviewReceiptHash)throw Error('REVIEW_IDENTITY');
 checkFrozenConfiguration(keccakUtf8,snapshot.configuration,p.configurationHash,e.event.bucketMs);
 // Paper freeze binds the audited committee receipt (which contains the manifest).
 if(snapshot.configuration.reviewHash!==review.receipt.receiptHash||digest(snapshot.configuration)!==digest(review.configuration))throw Error('FREEZE_REVIEW_MISMATCH');
 if(keccakUtf8(snapshotBytes)!==p.serviceProof.snapshotHash)throw Error('SNAPSHOT_BYTES_MISMATCH');
 const run=runs.find((r:any)=>r.runId===p.serviceProof.runId);
 const recomputed=targetsFromSnapshot(snapshot).map(x=>({asset:x.asset,exposureE9:x.exposureE9.toString()}));
 if(!run||run.status!=='executed'||run.dryRun!==true||run.evidence.snapshotHash!==p.serviceProof.snapshotHash||
   run.evidence.configurationHash!==p.configurationHash||digest(run.evidence.exposures)!==digest(recomputed)||
   run.plan.orders.length!==p.serviceProof.plannedOrders||digest(run.plan)!==digest(p.serviceProof.plan)||run.equityUsd!==p.serviceProof.equityUsd||
   !run.results.length||!run.results.every((r:any)=>r.status==='dry_run'))throw Error('RUN_EVIDENCE_MISMATCH');
 if(review.audit.length!==3||review.receipt.auditIds.some((id:string)=>!review.audit.some((r:any)=>r.id===id)))throw Error('MISSING_AUDIT');
}
console.log(JSON.stringify({status:'VERIFIED',files:manifest.files.length,codeCommit:manifest.codeCommit,codeHash:manifest.codeHash,
 assertions:'file checksums, stage commitments, Review receipt, frozen configuration, exact snapshot bytes, recomputed targets, persisted dry-run evidence',externalOrdersSubmitted:0}));

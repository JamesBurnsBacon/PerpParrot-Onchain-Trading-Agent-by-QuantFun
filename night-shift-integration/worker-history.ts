// Read-only evidence export; never starts, stops or updates the observed worker.
import { Database } from 'bun:sqlite';
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { parseArgs } from 'node:util';

export function inspectWorkerHistory(path:string, observedCodeCommit:string) {
  if(!/^[a-f0-9]{40}$/.test(observedCodeCommit))throw new Error('EXPECTED_FULL_OBSERVED_COMMIT');
  const db=new Database(path,{readonly:true});
  try {
    // A read transaction gives a consistent view while the original worker continues.
    db.exec('BEGIN');
    const rows=db.query<{body:string},[]>('select body from runs order by bucket').all().map(r=>JSON.parse(r.body));
    const runs=rows.map(r=>{
      let artifact:any=null;
      if(r.artifactHash){
        const stored=db.query<{raw:string},[string]>('select raw from blobs where hash=?').get(r.artifactHash);
        if(!stored||createHash('sha256').update(stored.raw).digest('hex')!==r.artifactHash)throw new Error('CORRUPT_PUBLISHED_ARTIFACT');
        artifact=JSON.parse(stored.raw);
        if(artifact.runId!==r.id||artifact.bucket!==r.bucket)throw new Error('RUN_ARTIFACT_IDENTITY');
      }
      const count=artifact?.inputs?.length??null;
      return {runId:r.id,bucket:r.bucket,status:r.status,startedAt:r.startedAt,finishedAt:r.finishedAt??null,
        startDelaySeconds:(r.startedAt-r.bucket)/1000,durationSeconds:r.finishedAt?(r.finishedAt-r.startedAt)/1000:null,
        finishedWithinSlot:r.finishedAt? r.finishedAt<=r.bucket+600_000:false,
        attempts:r.attempts,artifactHash:r.artifactHash??null,artifactHashVerified:!!artifact,
        count,uniqueAccounts:artifact?new Set(artifact.inputs.map((i:any)=>i.address)).size:null,
        completeHundred:artifact?.status==='complete'&&artifact.count===100&&count===100,
        upstream:artifact?.upstream??null,error:r.error??null};
    });
    const seen=new Set(runs.map(r=>r.bucket)),missingSlots:number[]=[];
    if(runs.length)for(let t=runs[0]!.bucket;t<=runs.at(-1)!.bucket;t+=600_000)if(!seen.has(t))missingSlots.push(t);
    const complete=runs.filter(r=>r.status==='complete'),durations=complete.map(r=>r.durationSeconds!).sort((a,b)=>a-b);
    let consecutiveTimelyTail=0;
    for(let i=runs.length-1;i>=0;i--){const r=runs[i]!;
      if(r.status!=='complete'||!r.finishedWithinSlot||!r.completeHundred||(i<runs.length-1&&runs[i+1]!.bucket-r.bucket!==600_000))break;
      consecutiveTimelyTail++;
    }
    db.exec('COMMIT');
    return {schema:'observed-worker-history.v1',observedAt:Date.now(),sourceKind:'REAL_OFFICIAL_API',observedCodeCommit,
      scope:'Existing worker before the new rotation/quarantine changes; not runtime proof of the new branch.',
      wallWindowHours:runs.length?((runs.at(-1)!.finishedAt??runs.at(-1)!.startedAt)-runs[0]!.startedAt)/3_600_000:0,
      attemptedSlots:runs.length,completed:complete.length,failed:runs.filter(r=>r.status==='failed').length,
      missingSlots,consecutiveTimelyTail,allPublishedHundredsValid:complete.every(r=>r.artifactHashVerified&&r.completeHundred&&r.uniqueAccounts===100),
      durationSeconds:{minimum:durations[0]??null,median:durations[Math.floor(durations.length/2)]??null,maximum:durations.at(-1)??null},runs};
  }finally{db.close();}
}

if(import.meta.main){const{values}=parseArgs({options:{db:{type:'string'},commit:{type:'string'},out:{type:'string',default:'night-shift-integration/out/observed-worker-history.json'}}});
  if(!values.db||!values.commit)throw new Error('Expected --db and --commit of the running worker');
  const report=inspectWorkerHistory(resolve(values.db),values.commit),path=resolve(values.out!);mkdirSync(dirname(path),{recursive:true});
  writeFileSync(path,JSON.stringify(report,null,2)+'\n');
  console.log(JSON.stringify({...report,runs:undefined}));
}

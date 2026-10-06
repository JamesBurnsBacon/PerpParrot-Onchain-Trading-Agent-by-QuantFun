import {mkdirSync,readFileSync,writeFileSync,copyFileSync,readdirSync,statSync,existsSync} from 'node:fs';
import {resolve,join,relative} from 'node:path';
import {parseArgs} from 'node:util';
import {execFileSync} from 'node:child_process';
import {byteDigest} from './contracts.ts';
const {values}=parseArgs({options:{demo:{type:'string',default:'night-shift-integration/out/demo'},out:{type:'string',default:'night-shift-integration/evidence'}}});
const demo=resolve(values.demo!),out=resolve(values.out!);mkdirSync(out,{recursive:true});
function copy(from:string,to:string){mkdirSync(join(out,to,'..'),{recursive:true});copyFileSync(from,join(out,to));}
copy(join(demo,'evidence.json'),'demo/evidence.json');copy(join(demo,'demo.html'),'demo/demo.html');
const evidence=JSON.parse(readFileSync(join(demo,'evidence.json'),'utf8'));
for(const p of evidence.proofs){
 const stage=p.algorithm.split('.')[0],base=join(demo,evidence.receipt.runId,stage+'-review-db');
 copy(base+'-review-evidence.json',`controlled/${stage}/review.json`);
 const services=base+'-services',directories=readdirSync(services).filter(f=>f.startsWith('proof-'));
 const match=directories.map(f=>join(services,f)).find(d=>existsSync(join(d,'proof.json'))&&
   JSON.parse(readFileSync(join(d,'proof.json'),'utf8')).snapshotHash===p.serviceProof.snapshotHash);
 if(!match)throw Error('MISSING_SERVICE_EVIDENCE');
 for(const f of ['snapshot.json','dashboard-runs.json','proof.json'])copy(join(match,f),`controlled/${stage}/${f}`);
}
function walk(path:string):string[]{return readdirSync(path).sort().flatMap(f=>{const p=join(path,f);return statSync(p).isDirectory()?walk(p):[p];});}
const files=walk(out).filter(p=>!['manifest.json','SHA256SUMS'].includes(relative(out,p))).map(p=>({path:relative(out,p),bytes:statSync(p).size,sha256:byteDigest(readFileSync(p))}));
const manifest={schemaVersion:'night-evidence-bundle.v1',recordedAt:new Date().toISOString(),
 codeCommit:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),baseCommit:'af7e85749fb35527b41b5a5dbf308514e0d877cf',
 codeHash:evidence.event.codeHash,source:'Controlled proof plus separately labeled real-data summaries',
 exclusions:['credentials','raw production logs','private databases','wallet keys','signed exchange payloads'],files};
writeFileSync(join(out,'manifest.json'),JSON.stringify(manifest,null,2)+'\n');
writeFileSync(join(out,'SHA256SUMS'),files.map(f=>f.sha256+'  '+f.path).join('\n')+'\n'+byteDigest(readFileSync(join(out,'manifest.json')))+'  manifest.json\n');
console.log(JSON.stringify({status:'EXPORTED',files:files.length,bytes:files.reduce((n,f)=>n+f.bytes,0),out}));

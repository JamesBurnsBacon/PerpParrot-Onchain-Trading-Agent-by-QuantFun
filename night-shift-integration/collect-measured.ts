// Read-only public evidence collection. Raw data remains in ignored out/; no keys or orders.
import { Database } from 'bun:sqlite';
import { mkdirSync, readFileSync, writeFileSync, existsSync, renameSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { parseArgs } from 'node:util';
import { createHash } from 'node:crypto';
import { LoopStore } from '../packages/backend/src/ingest/loop/store.ts';
import { BudgetClient } from '../packages/backend/src/ingest/loop/client.ts';
import { SOURCES, type Fetcher } from '../packages/backend/src/ingest/client.ts';
import { scoreCandidates } from '../packages/backend/src/score/score.ts';
import type { ScoreInput } from '../packages/backend/src/score/types.ts';
import { fillIdentity, type FillCoverage, type NormalizedFill } from '../packages/backend/review/measured-evidence.ts';

const sha = (raw: string) => createHash('sha256').update(raw).digest('hex');
const save = (path: string, value: unknown) => { writeFileSync(path+'.tmp',JSON.stringify(value)); renameSync(path+'.tmp',path); };
const read = <T>(path: string): T => JSON.parse(readFileSync(path,'utf8'));

type PublicRead = (body:Record<string,unknown>,weight?:number)=>Promise<{value:unknown;rawSha256:string}>;
type FillPage=FillCoverage['pages'][number];
const rowKey=fillIdentity;
function parsePage(value:unknown,startMs:number,endMs:number):NormalizedFill[]{
  if(!Array.isArray(value)||value.length>2000||value.some((f:any,index:number)=>!f||typeof f.coin!=='string'
    ||!Number.isSafeInteger(f.tid)||!Number.isSafeInteger(f.time)||f.time<startMs||f.time>endMs
    ||(index>0&&value[index-1].time>f.time)))throw new Error('INVALID_FILL_PAGE');
  return value;
}
function pageEvidence(rows:NormalizedFill[],startMs:number,endMs:number,rawSha256:string):FillPage {
  return {requestStartMs:startMs,requestEndMs:endMs,rawSha256,count:rows.length,
    ...(rows.length?{firstFillMs:rows[0]!.time,lastFillMs:rows.at(-1)!.time}:{})};
}
function mergeRows(rows:NormalizedFill[]){
  const byId=new Map<string,NormalizedFill>();let conflict=false;
  for(const row of rows){const key=rowKey(row),old=byId.get(key);
    if(old&&JSON.stringify(old)!==JSON.stringify(row))conflict=true;else byId.set(key,row);}
  return {rows:[...byId.values()].sort((a,b)=>a.time-b.time||a.coin.localeCompare(b.coin)||a.tid-b.tid),conflict};
}

/** Inclusive boundary overlap, bounded retention and explicit incomplete coverage. */
export async function collectFillWindow(get:PublicRead,address:string,startMs:number,endMs:number,
  limits:{maxPages?:number;maxRows?:number}={}):Promise<FillCoverage>{
  const maxPages=limits.maxPages??7,maxRows=limits.maxRows??10000;
  if(!Number.isSafeInteger(startMs)||!Number.isSafeInteger(endMs)||startMs>endMs
    ||!Number.isSafeInteger(maxPages)||maxPages<1||maxPages>20
    ||!Number.isSafeInteger(maxRows)||maxRows<1||maxRows>10000)throw new Error('INVALID_FILL_BOUNDS');
  const pages:FillPage[]=[],rows:NormalizedFill[]=[];let cursor=startMs,complete=false,reason='PAGE_LIMIT';
  for(let page=0;page<maxPages;page++){
    const response=await get({type:'userFillsByTime',user:address,startTime:cursor,endTime:endMs,aggregateByTime:false},120);
    const batch=parsePage(response.value,cursor,endMs);pages.push(pageEvidence(batch,cursor,endMs,response.rawSha256));
    rows.push(...batch);const merged=mergeRows(rows);
    if(merged.conflict){reason='CONFLICTING_DUPLICATE_FILL';break;}
    if(merged.rows.length>=maxRows){reason='UPSTREAM_10000_FILL_RETENTION';break;}
    if(batch.length<2000){complete=true;reason='';break;}
    const next=batch.at(-1)!.time;
    if(next<=cursor){reason='TIMESTAMP_PAGINATION_STALLED';break;}
    cursor=next;
  }
  return {rows:mergeRows(rows).rows,startMs,endMs,complete,pages,missingReasons:reason?[reason]:[]};
}

/** Rebuild boundary metadata only from retained raw bytes whose hash/count/range agree. */
export function enrichFillCoverage(previous:FillCoverage,readRaw:(hash:string)=>string):FillCoverage {
  const allRows:NormalizedFill[]=[];
  const pages=previous.pages.map(page=>{
    const raw=readRaw(page.rawSha256);
    if(sha(raw)!==page.rawSha256)throw new Error('CORRUPT_RAW_FILL_PAGE');
    const rows=parsePage(JSON.parse(raw),page.requestStartMs,page.requestEndMs);
    if(rows.length!==page.count)throw new Error('FILL_PAGE_COUNT_MISMATCH');
    allRows.push(...rows);
    return pageEvidence(rows,page.requestStartMs,page.requestEndMs,page.rawSha256);
  });
  const merged=mergeRows(allRows),reasons=[...(previous.missingReasons??[])];
  const repairedTerminalPage=!merged.conflict&&!previous.complete&&reasons.length===1
    &&reasons[0]==='CONFLICTING_DUPLICATE_FILL'&&pages.length===1&&pages[0]!.count<2000
    &&pages[0]!.requestStartMs<=previous.startMs&&pages[0]!.requestEndMs>=previous.endMs;
  // Re-normalize retained bytes after fixing exchange IDs such as repeated tid=0.
  // A prematurely stopped fetch remains incomplete; repairing IDs cannot fill a gap.
  if(!merged.conflict&&reasons.includes('CONFLICTING_DUPLICATE_FILL')){
    reasons.splice(reasons.indexOf('CONFLICTING_DUPLICATE_FILL'),1);
    if(!repairedTerminalPage)reasons.push('INCOMPLETE_AFTER_FILL_IDENTITY_REPAIR');
  }
  if(merged.conflict&&!reasons.includes('CONFLICTING_DUPLICATE_FILL'))reasons.push('CONFLICTING_DUPLICATE_FILL');
  return {...previous,pages,rows:merged.rows.filter(r=>r.time>=previous.startMs&&r.time<=previous.endMs),
    complete:(previous.complete||repairedTerminalPage)&&!merged.conflict&&reasons.length===0,missingReasons:reasons};
}

/** The old missing interval cannot be healed by observing only a new suffix. */
export function mergeFillCoverage(previous:FillCoverage,delta:FillCoverage):FillCoverage {
  if(delta.startMs!==previous.endMs||delta.endMs<previous.endMs)throw new Error('DELTA_FILL_GAP');
  const startMs=delta.endMs-30*86_400_000,merged=mergeRows([...previous.rows,...delta.rows]);
  const reasons=[...(previous.missingReasons??[]),...(delta.missingReasons??[])];
  if(!previous.complete)reasons.push('ORIGINAL_FILL_COVERAGE_INCOMPLETE');
  if(merged.conflict)reasons.push('CONFLICTING_DUPLICATE_FILL');
  if(previous.startMs>startMs)reasons.push('FILL_WINDOW_START_GAP');
  const complete=previous.complete&&delta.complete&&!merged.conflict&&reasons.length===0;
  return {rows:merged.rows.filter(r=>r.time>=startMs&&r.time<=delta.endMs),startMs,endMs:delta.endMs,
    complete,pages:[...previous.pages,...delta.pages],missingReasons:[...new Set(reasons)]};
}

export function declaredPerpDexes(value:unknown):string[]{
  if(!Array.isArray(value)||!value.length)throw new Error('INVALID_PERP_DEX_LIST');
  const names=value.map((v:any)=>v===null?'':typeof v?.name==='string'?v.name:null);
  if(names.some(n=>n===null||!/^[a-z0-9_-]*$/i.test(n)))throw new Error('INVALID_PERP_DEX_NAME');
  return [...new Set(['',...names as string[]])];
}

/** Complete account evidence does not expand the mirror's core/xyz market allowlist. */
export async function collectStateRead(get:PublicRead,address:string,declaredDexes:string[],allDexes:boolean,now:()=>number=Date.now){
  const startedAtMs=now(),requestedDexes=[...new Set(['','xyz',...(allDexes?declaredDexes:[])])];
  const allStates:{dex:string;state:unknown;rawSha256:string;startedAtMs:number;completedAtMs:number}[]=[];
  for(const dex of requestedDexes){
    const started=now(),response=await get({type:'clearinghouseState',user:address,...(dex?{dex}:{})},2);
    allStates.push({dex,state:response.value,rawSha256:response.rawSha256,startedAtMs:started,completedAtMs:now()});
  }
  const portfolio=await get({type:'portfolio',user:address});
  return {address,portfolio:portfolio.value,states:['','xyz'].map(dex=>allStates.find(s=>s.dex===dex)!.state),allStates,
    stateCoverage:{declaredDexes:[...declaredDexes],requestedDexes,complete:declaredDexes.every(d=>requestedDexes.includes(d))},
    startedAtMs,completedAtMs:now(),rawSha256:[...allStates.map(s=>s.rawSha256),portfolio.rawSha256]};
}

export async function collectMeasured(args: {db: string; out: string; limit: number; positionsOnly?: boolean; sampleOnly?:boolean; maxPages?:number}) {
  if(args.positionsOnly&&args.sampleOnly)throw new Error('Choose positions-only OR sample-only');
  mkdirSync(args.out,{recursive:true});
  const source=new Database(args.db,{readonly:true});
  const latest=JSON.parse((source.query('select body from state where key=?').get('latest') as {body:string}).body);
  const raw=(source.query('select raw from blobs where hash=?').get(latest.artifactHash) as {raw:string}).raw;
  if(sha(raw)!==latest.artifactHash)throw new Error('CORRUPT_INGEST_ARTIFACT');
  const artifact=JSON.parse(raw) as {inputs:ScoreInput[];completedAt:number;runId:string};
  if(Date.now()-artifact.completedAt>86_400_000)throw new Error('INGEST_INPUT_OLDER_THAN_24H');
  const selection=scoreCandidates(artifact.inputs);
  const byAddress=new Map(artifact.inputs.map(i=>[i.address,i]));
  const priorPath=join(args.out,'input.json');
  const prior=existsSync(priorPath)?read<{addresses:string[];artifactHash:string}>(priorPath):null;
  if(!prior)writeFileSync(join(args.out,'source-ingest-'+latest.artifactHash+'.json'),raw);
  // Continuations keep the original acquisition identity even when a newer publication exists.
  const addresses=prior?.addresses??selection.finalists.slice(0,args.limit);
  if(!prior)save(priorPath,{schema:'measured-acquisition.v1',createdAt:Date.now(),artifactHash:latest.artifactHash,runId:artifact.runId,
    inputAsOfMs:artifact.completedAt,addresses,inputs:addresses.map(a=>byAddress.get(a))});
  source.close();
  const store=new LoopStore(join(args.out,'budget.sqlite'));
  // Original collector uses <=800 weight/minute. This separate task adds <=300,
  // including retries, through a wrapper around every network attempt.
  const requestSignal=AbortSignal.timeout(45*60_000);
  let reservedWeight=20,lastReservation=0;
  const limitedFetch:Fetcher=async(input,init)=>{
    for(;;){requestSignal.throwIfAborted();const r=store.reserve('measured-shared-ip',reservedWeight,300,Date.now());
      if(!r.wait){lastReservation=r.id;break;}await Bun.sleep(Math.min(r.wait,1000));}
    // The queue is not network time. Start the per-attempt network deadline after
    // acquiring this second budget, while preserving the enclosing cancellation.
    return fetch(input,{...init,signal:AbortSignal.any([requestSignal,AbortSignal.timeout(25_000)])});
  };
  const client=new BudgetClient(store,limitedFetch);
  const get=async(body:Record<string,unknown>,weight=20)=>{
    reservedWeight=weight;
    const raw=await client.request(SOURCES.info,body,requestSignal,weight,
      body.type==='userFillsByTime'?items=>Array.isArray(items)&&items.length<=2000?20+Math.ceil(items.length/20):121:undefined);
    if(body.type==='userFillsByTime'){
      const items=JSON.parse(raw);if(Array.isArray(items)&&items.length<=2000)store.refund(lastReservation,20+Math.ceil(items.length/20));
    }
    const hash=sha(raw);writeFileSync(join(args.out,'raw-'+hash+'.json'),raw);
    return {value:JSON.parse(raw),rawSha256:hash};
  };
  try {
    const marketStart=Date.now(),dexes=await get({type:'perpDexs'}),core=await get({type:'metaAndAssetCtxs'}),xyz=await get({type:'metaAndAssetCtxs',dex:'xyz'});
    const declaredDexes=declaredPerpDexes(dexes.value);
    save(join(args.out,'markets.json'),{perpDexs:dexes.value,core:core.value,xyz:xyz.value,startedAtMs:marketStart,completedAtMs:Date.now(),rawSha256:[dexes.rawSha256,core.rawSha256,xyz.rawSha256]});
    for(const [index,address] of addresses.entries()){
      const p=join(args.out,address+'.json');
      const saved:any=existsSync(p)?read(p):{address,reads:[],fills:null};
      if(!args.positionsOnly&&!args.sampleOnly&&saved.fills&&saved.reads.length){console.log(JSON.stringify({stage:'resume',completed:index+1,total:addresses.length}));continue;}
      if((args.positionsOnly||args.sampleOnly)&&!saved.fills)throw new Error('POSITIONS_RESAMPLE_NEEDS_ORIGINAL_FILLS');
      // Close the fill interval FIRST. The current-state reads below are then at
      // or after that cutoff; observed discrepancies remain explicit evidence.
      if(!args.sampleOnly){
        const endMs=Date.now();
        if(saved.fills){
          const priorFills=enrichFillCoverage(saved.fills,h=>readFileSync(join(args.out,'raw-'+h+'.json'),'utf8'));
          const delta=await collectFillWindow(get,address,priorFills.endMs,endMs);
          saved.fills=mergeFillCoverage(priorFills,delta);
        }else saved.fills=await collectFillWindow(get,address,endMs-30*86_400_000,endMs,{maxPages:args.maxPages});
        save(p,saved);
      }
      saved.reads.push(await collectStateRead(get,address,declaredDexes,true));
      save(p,saved);
      console.log(JSON.stringify({stage:args.sampleOnly?'sample':args.positionsOnly?'positions':'evidence',completed:index+1,total:addresses.length,
        fills:saved.fills?.rows.length,fillCoverageComplete:saved.fills?.complete,samples:saved.reads.length}));
    }
    save(join(args.out,'collection-receipt.json'),{completedAt:Date.now(),count:addresses.length,requests:client.requests,retries:client.retries,rateLimited:client.rateLimited,
      source:'official-public-api',positionsOnly:!!args.positionsOnly,sampleOnly:!!args.sampleOnly,economicAuthority:false});
  }finally{store.close();}
}
if(import.meta.main){
  const {values}=parseArgs({options:{db:{type:'string'},out:{type:'string',default:'night-shift-integration/out/measured'},limit:{type:'string',default:'25'},'positions-only':{type:'boolean',default:false},'sample-only':{type:'boolean',default:false},'max-pages':{type:'string',default:'7'}}});
  const limit=Number(values.limit);if(!values.db||!Number.isInteger(limit)||limit<1||limit>25)throw new Error('Expected --db and --limit 1..25');
  await collectMeasured({db:resolve(values.db),out:resolve(values.out!),limit,positionsOnly:values['positions-only'],sampleOnly:values['sample-only'],maxPages:Number(values['max-pages'])});
}

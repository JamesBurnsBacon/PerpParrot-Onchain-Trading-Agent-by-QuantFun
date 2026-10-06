import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { Database } from 'bun:sqlite';
import { scoreCandidates } from '../packages/backend/src/score/score.ts';
import { declaredPerpDexes } from './collect-measured.ts';
import { fillIdentity } from '../packages/backend/review/measured-evidence.ts';

const sha=(raw:string)=>createHash('sha256').update(raw).digest('hex');
const fail=(code:string):never=>{throw new Error('MEASURED_ARCHIVE_'+code);};
const equal=(a:unknown,b:unknown,code:string)=>{if(!isDeepStrictEqual(a,b))fail(code);};
const instant=(n:unknown):n is number=>typeof n==='number'&&Number.isSafeInteger(n)&&n>=0;
const address=(s:unknown):s is string=>typeof s==='string'&&/^0x[0-9a-f]{40}$/.test(s);
const hash=(s:unknown):s is string=>typeof s==='string'&&/^[a-f0-9]{64}$/.test(s);

/** Reconstruct normalized values from retained response bytes before any metric.
 * Request identity is additionally checked when the local acquisition journal is
 * retained. Without that journal this proves raw-content consistency, not who the
 * server answered; the returned verification scope states that distinction.
 */
export function verifyMeasuredArchive(directory:string){
  const read=(name:string)=>JSON.parse(readFileSync(join(directory,name),'utf8'));
  const input=read('input.json'),markets=read('markets.json'),cache=new Map<string,any>();
  if(input.schema!=='measured-acquisition.v1'||!hash(input.artifactHash)||!Array.isArray(input.addresses)
    ||!input.addresses.length||input.addresses.some((a:unknown)=>!address(a))
    ||new Set(input.addresses).size!==input.addresses.length||!Array.isArray(input.inputs))fail('INVALID_INPUT');
  const sourceRaw=readFileSync(join(directory,'source-ingest-'+input.artifactHash+'.json'),'utf8');
  if(sha(sourceRaw)!==input.artifactHash)fail('SOURCE_INGEST_HASH');
  const source=JSON.parse(sourceRaw);
  if(source.schema!=='ingest-cycle.v1'||source.status!=='complete'||source.runId!==input.runId
    ||source.completedAt!==input.inputAsOfMs||!Array.isArray(source.inputs)
    ||new Set(source.inputs.map((i:any)=>i.address)).size!==source.inputs.length)fail('SOURCE_INGEST_IDENTITY');
  const sourceInputs=new Map<string,any>(source.inputs.map((i:any)=>[i.address,i]));
  equal(input.inputs,input.addresses.map((a:string)=>sourceInputs.get(a)),'SOURCE_INPUT_BINDING');
  equal(input.addresses,scoreCandidates(source.inputs).finalists.slice(0,input.addresses.length),'SOURCE_FINALIST_SELECTION');
  const raw=(h:string)=>{
    if(!hash(h))return fail('INVALID_HASH');
    if(!cache.has(h)){const text=readFileSync(join(directory,'raw-'+h+'.json'),'utf8');if(sha(text)!==h)fail('RAW_HASH');cache.set(h,JSON.parse(text));}
    return cache.get(h);
  };
  const journalPath=join(directory,'budget.sqlite');let journal:Map<string,any[]>|null=null;
  if(existsSync(journalPath)){
    const db=new Database(journalPath,{readonly:true});
    try{journal=new Map();for(const {body} of db.query<{body:string},[]>('SELECT body FROM request_attempts').all()){
      const r=JSON.parse(body);if(r.status!=='success'||!hash(r.rawHash))continue;
      const list=journal.get(r.rawHash)??[];list.push(r);journal.set(r.rawHash,list);
    }}finally{db.close();}
  }
  let boundRequests=0;
  const request=(h:string,body:Record<string,unknown>,start?:number,end?:number)=>{
    if(!journal)return;
    const found=journal.get(h)?.some(r=>isDeepStrictEqual(r.request,body)
      &&(start===undefined||(instant(r.startedAt)&&r.startedAt>=start))
      &&(end===undefined||(instant(r.finishedAt)&&r.finishedAt<=end)));
    if(!found)fail('REQUEST_RESPONSE_BINDING');boundRequests++;
  };
  const times=(r:any)=>{if(!instant(r.startedAtMs)||!instant(r.completedAtMs)||r.startedAtMs>r.completedAtMs)fail('READ_TIMES');};
  times(markets);
  if(!Array.isArray(markets.rawSha256)||markets.rawSha256.length!==3)fail('MARKET_HASHES');
  for(const [i,key]of ['perpDexs','core','xyz'].entries()){
    equal(markets[key],raw(markets.rawSha256[i]),'MARKET_BINDING');
    request(markets.rawSha256[i],i===0?{type:'perpDexs'}:i===1?{type:'metaAndAssetCtxs'}:{type:'metaAndAssetCtxs',dex:'xyz'},markets.startedAtMs,markets.completedAtMs);
  }
  const declared=declaredPerpDexes(markets.perpDexs);
  let reads=0,completeAllDexReads=0,legacyIncompleteReads=0,fillPages=0;
  for(const a of input.addresses as string[]){
    const account=read(a+'.json');
    if(account.address!==a||!Array.isArray(account.reads)||!account.reads.length)fail('ACCOUNT_IDENTITY');
    for(const r of account.reads){
      times(r);if(r.address!==a||!Array.isArray(r.rawSha256)||!Array.isArray(r.states)||r.states.length!==2)fail('READ_IDENTITY');
      reads++;
      const bound=r.rawSha256.map(raw);
      const portfolioIndex=bound.findIndex((v:any)=>isDeepStrictEqual(v,r.portfolio));
      if(portfolioIndex<0)fail('PORTFOLIO_BINDING');
      request(r.rawSha256[portfolioIndex],{type:'portfolio',user:a},r.startedAtMs,r.completedAtMs);
      if(Array.isArray(r.allStates)){
        if(!r.allStates.length||new Set(r.allStates.map((s:any)=>s.dex)).size!==r.allStates.length)fail('DEX_DUPLICATE');
        equal(r.rawSha256,[...r.allStates.map((s:any)=>s.rawSha256),r.rawSha256[portfolioIndex]],'DEX_HASH_SET');
        const c=r.stateCoverage;if(!c||typeof c.complete!=='boolean'||!Array.isArray(c.declaredDexes)||!Array.isArray(c.requestedDexes))fail('DEX_COVERAGE');
        equal(c.requestedDexes,r.allStates.map((s:any)=>s.dex),'DEX_REQUEST_SET');
        if(c.complete){
          equal([...c.declaredDexes].sort(),[...declared].sort(),'DECLARED_DEX_BINDING');
          if(declared.some(d=>!c.requestedDexes.includes(d)))fail('INCOMPLETE_ALL_DEX');
          completeAllDexReads++;
        }
        for(const s of r.allStates){
          times(s);if(typeof s.dex!=='string'||s.startedAtMs<r.startedAtMs||s.completedAtMs>r.completedAtMs)fail('DEX_READ_TIMES');
          equal(s.state,raw(s.rawSha256),'STATE_BINDING');
          request(s.rawSha256,{type:'clearinghouseState',user:a,...(s.dex?{dex:s.dex}:{})},s.startedAtMs,s.completedAtMs);
        }
        equal(r.states,['','xyz'].map(dex=>r.allStates.find((s:any)=>s.dex===dex)?.state),'MIRROR_VIEW_BINDING');
      }else{
        if(r.stateCoverage?.complete===true||bound.length!==3)fail('LEGACY_CANNOT_BE_COMPLETE');
        legacyIncompleteReads++;
        for(const [i,state]of r.states.entries()){
          const index=bound.findIndex((v:any)=>isDeepStrictEqual(v,state));if(index<0)fail('LEGACY_STATE_BINDING');
          request(r.rawSha256[index],{type:'clearinghouseState',user:a,...(i===1?{dex:'xyz'}:{})},r.startedAtMs,r.completedAtMs);
        }
      }
    }
    const f=account.fills;
    if(!f||!instant(f.startMs)||!instant(f.endMs)||f.startMs>=f.endMs||!Array.isArray(f.pages)||!Array.isArray(f.rows))fail('FILL_BOUNDS');
    const dedup=new Map<string,any>();let conflict=false;
    for(const p of f.pages){
      if(!instant(p.requestStartMs)||!instant(p.requestEndMs)||p.requestStartMs>p.requestEndMs)fail('FILL_PAGE_BOUNDS');
      const rows=raw(p.rawSha256);fillPages++;
      if(!Array.isArray(rows)||rows.length!==p.count||rows.length>2000)fail('FILL_PAGE_COUNT');
      request(p.rawSha256,{type:'userFillsByTime',user:a,startTime:p.requestStartMs,endTime:p.requestEndMs,aggregateByTime:false});
      if(p.firstFillMs!==undefined&&p.firstFillMs!==rows[0]?.time)fail('FILL_BOUNDARY');
      if(p.lastFillMs!==undefined&&p.lastFillMs!==rows.at(-1)?.time)fail('FILL_BOUNDARY');
      for(const [i,row]of rows.entries()){
        if(!row||typeof row.coin!=='string'||!instant(row.tid)||!instant(row.time)||row.time<p.requestStartMs||row.time>p.requestEndMs
          ||(i>0&&rows[i-1].time>row.time))fail('INVALID_RAW_FILL');
        const key=fillIdentity(row),previous=dedup.get(key);
        if(previous&&!isDeepStrictEqual(previous,row))conflict=true;else dedup.set(key,row);
      }
    }
    const compare=(a:any,b:any)=>a.time-b.time||a.coin.localeCompare(b.coin)||a.tid-b.tid;
    const expected=[...dedup.values()].filter(row=>row.time>=f.startMs&&row.time<=f.endMs).sort(compare);
    equal([...f.rows].sort(compare),expected,'NORMALIZED_FILL_BINDING');
    if(f.complete&&(conflict||f.missingReasons?.length))fail('FALSE_FILL_COMPLETENESS');
  }
  return {schema:'measured-archive-verification.v1',accounts:input.addresses.length,reads,completeAllDexReads,
    legacyIncompleteReads,fillPages,rawFiles:cache.size,sourceIngestSha256:input.artifactHash,scoreFinalistPrefixVerified:true,
    requestIdentity:journal?'SQLITE_REQUEST_RESPONSE_VERIFIED':'JOURNAL_UNAVAILABLE_RAW_CONTENT_ONLY',boundRequests};
}

import {describe,test,expect} from 'bun:test';
import {createHash} from 'node:crypto';
import {collectFillWindow,enrichFillCoverage,mergeFillCoverage,declaredPerpDexes,collectStateRead} from './collect-measured.ts';
import type {FillCoverage,NormalizedFill} from '../packages/backend/review/measured-evidence.ts';
const DAY=86_400_000,END=1_791_300_000_000,START=END-30*DAY;
const sha=(raw:string)=>createHash('sha256').update(raw).digest('hex');
const fill=(time:number,tid:number):NormalizedFill=>({coin:'BTC',time,tid,side:'B',sz:'1',px:'100',startPosition:'0',crossed:false});
function getter(batches:NormalizedFill[][]){const requests:Record<string,unknown>[]=[];return {requests,get:async(body:Record<string,unknown>)=>{
  requests.push(body);const value=batches.shift();if(!value)throw new Error('UNEXPECTED_REQUEST');return {value,rawSha256:sha(JSON.stringify(value))};}};}
const coverage=(rows:NormalizedFill[],startMs=START,endMs=END):FillCoverage=>({rows,startMs,endMs,complete:true,
  pages:[{requestStartMs:startMs,requestEndMs:endMs,count:rows.length,rawSha256:sha(JSON.stringify(rows))}],missingReasons:[]});

describe('bounded measured-fill collection helpers',()=>{
  test('overlaps a full-page timestamp and deduplicates the boundary fill',async()=>{
    const page=Array.from({length:2000},(_,i)=>fill(START+i,i));
    const fake=getter([page,[page.at(-1)!,fill(START+2000,2000)]]);
    const result=await collectFillWindow(fake.get,'account',START,END);
    expect(result.complete).toBe(true);expect(result.rows.length).toBe(2001);
    expect(fake.requests[1]!.startTime).toBe(START+1999);
    expect(result.pages[0]!.lastFillMs).toBe(START+1999);
  });
  test('same-timestamp saturation and bounded page exhaustion remain incomplete',async()=>{
    const saturated=getter([Array.from({length:2000},(_,i)=>fill(START,i))]);
    const a=await collectFillWindow(saturated.get,'account',START,END);
    expect(a.complete).toBe(false);expect(a.missingReasons).toContain('TIMESTAMP_PAGINATION_STALLED');
    const pages=getter([Array.from({length:2000},(_,i)=>fill(START+i,i))]);
    const b=await collectFillWindow(pages.get,'account',START,END,{maxPages:1});
    expect(b.missingReasons).toContain('PAGE_LIMIT');expect(pages.requests.length).toBe(1);
  });
  test('row cap and conflicting pagination copies do not claim complete history',async()=>{
    const cap=getter([[fill(START,0),fill(START+1,1)]]);
    expect((await collectFillWindow(cap.get,'account',START,END,{maxRows:2})).complete).toBe(false);
    const page=Array.from({length:2000},(_,i)=>fill(START+i,i));
    const conflict=getter([page,[{...page.at(-1)!,sz:'2'}]]);
    expect((await collectFillWindow(conflict.get,'account',START,END)).missingReasons).toContain('CONFLICTING_DUPLICATE_FILL');
  });
  test('enriches old page boundaries from verified original bytes, never from guessed metadata',()=>{
    const rows=[fill(START+1,1),fill(START+3,2)],raw=JSON.stringify(rows),old=coverage(rows);
    const enriched=enrichFillCoverage(old,()=>raw);
    expect(enriched.pages[0]!.firstFillMs).toBe(START+1);expect(enriched.pages[0]!.lastFillMs).toBe(START+3);
    expect(old.pages[0]!.lastFillMs).toBeUndefined();
    expect(()=>enrichFillCoverage(old,()=>raw+' ')).toThrow('CORRUPT_RAW_FILL_PAGE');
    old.pages[0]!.count=99;expect(()=>enrichFillCoverage(old,()=>raw)).toThrow('FILL_PAGE_COUNT_MISMATCH');
  });
  test('retains distinct zero-id spot events and repairs normalized rows from raw bytes',async()=>{
    const rows=[{...fill(START+1,0),coin:'@334',oid:123},{...fill(START+2,0),coin:'@334',oid:456}];
    const result=await collectFillWindow(getter([rows]).get,'account',START,END);
    expect(result.complete).toBe(true);expect(result.rows).toEqual(rows);
    const old=coverage(rows);old.rows=[rows[0]!];old.complete=false;old.missingReasons=['CONFLICTING_DUPLICATE_FILL'];
    const repaired=enrichFillCoverage(old,()=>JSON.stringify(rows));
    expect(repaired.rows).toEqual(rows);expect(repaired.complete).toBe(false);
    expect(repaired.missingReasons).toEqual(['INCOMPLETE_AFTER_FILL_IDENTITY_REPAIR']);
  });
  test('extends the exact inclusive endpoint and preserves raw page proof while rolling to thirty days',()=>{
    const boundary=fill(END,2),old=coverage([fill(START,0),fill(START+2*DAY,1),boundary]);
    const delta=coverage([boundary,fill(END+DAY,3)],END,END+DAY);
    const merged=mergeFillCoverage(old,delta);
    expect(merged.startMs).toBe(START+DAY);expect(merged.endMs).toBe(END+DAY);
    expect(merged.rows.map(r=>r.tid)).toEqual([1,2,3]);expect(merged.pages.length).toBe(2);expect(merged.complete).toBe(true);
    expect(()=>mergeFillCoverage(old,{...delta,startMs:END+1})).toThrow('DELTA_FILL_GAP');
  });
  test('incremental observations never promote an incomplete original acquisition',()=>{
    const old=coverage([]);old.complete=false;old.missingReasons=['UPSTREAM_10000_FILL_RETENTION'];
    const merged=mergeFillCoverage(old,coverage([],END,END+DAY));
    expect(merged.complete).toBe(false);expect(merged.missingReasons).toContain('UPSTREAM_10000_FILL_RETENTION');
    expect(merged.missingReasons).toContain('ORIGINAL_FILL_COVERAGE_INCOMPLETE');
  });
  test('rejects out-of-range or unordered provider rows without changing the requested cutoff',async()=>{
    const future=getter([[fill(END+1,1)]]);
    await expect(collectFillWindow(future.get,'account',START,END)).rejects.toThrow('INVALID_FILL_PAGE');
    const reverse=getter([[fill(START+2,1),fill(START+1,2)]]);
    await expect(collectFillWindow(reverse.get,'account',START,END)).rejects.toThrow('INVALID_FILL_PAGE');
  });
  test('queries each declared dex once, retaining core/xyz mirror states and full coverage metadata',async()=>{
    const dexes=declaredPerpDexes([null,{name:'xyz'},{name:'flx'},{name:'xyz'}]);
    expect(dexes).toEqual(['','xyz','flx']);
    const requests:Record<string,unknown>[]=[];
    const get=async(body:Record<string,unknown>)=>{requests.push(body);return {value:{dex:body.dex??'',type:body.type},rawSha256:sha(JSON.stringify(body))};};
    let time=END;const read=await collectStateRead(get,'account',dexes,true,()=>++time);
    expect(requests.filter(r=>r.type==='clearinghouseState').map(r=>r.dex??'')).toEqual(['','xyz','flx']);
    expect(read.states).toEqual([{dex:'',type:'clearinghouseState'},{dex:'xyz',type:'clearinghouseState'}]);
    expect(read.allStates.map(s=>s.dex)).toEqual(['','xyz','flx']);
    expect(read.stateCoverage).toEqual({declaredDexes:dexes,requestedDexes:dexes,complete:true});
    expect(read.rawSha256.length).toBe(4);
    expect(requests.some(r=>r.type==='userFillsByTime')).toBe(false);
  });
  test('legacy core/xyz reads are explicitly incomplete when other dexes were declared',async()=>{
    const read=await collectStateRead(async(body)=>({value:body,rawSha256:sha(JSON.stringify(body))}),
      'account',['','xyz','flx'],false,()=>END);
    expect(read.stateCoverage.complete).toBe(false);expect(read.stateCoverage.requestedDexes).toEqual(['','xyz']);
    expect(read.states.length).toBe(2);expect(read.allStates.length).toBe(2);
  });
});

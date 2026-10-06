import {afterEach,expect,test} from 'bun:test';
import {mkdtempSync,readFileSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {Database} from 'bun:sqlite';
import {sampleInputs} from '../packages/backend/test/score/helpers.ts';
import {verifyMeasuredArchive} from './verify-measured.ts';

const dirs:string[]=[],NOW=1_791_300_000_000,ADDRESS='0x'+'1'.repeat(40);
afterEach(()=>{for(const dir of dirs.splice(0))rmSync(dir,{recursive:true,force:true});});
const sha=(raw:string)=>createHash('sha256').update(raw).digest('hex');
function fixture(journal=false){
  const directory=mkdtempSync(join(tmpdir(),'measured-binding-'));dirs.push(directory);
  const write=(name:string,value:unknown)=>writeFileSync(join(directory,name),JSON.stringify(value));
  const attempts:any[]=[];
  const save=(value:unknown,request:unknown)=>{const bytes=JSON.stringify(value),h=sha(bytes);writeFileSync(join(directory,'raw-'+h+'.json'),bytes);
    attempts.push({status:'success',rawHash:h,request,startedAt:NOW,finishedAt:NOW});return h;};
  const sourceInput={...structuredClone(sampleInputs.find(i=>i.address==='addr-21')!),address:ADDRESS,tradeCount:10,closed:false};
  const source={schema:'ingest-cycle.v1',status:'complete',runId:'ingest-test',completedAt:NOW,inputs:[sourceInput]};
  const bytes=JSON.stringify(source),artifactHash=sha(bytes);writeFileSync(join(directory,'source-ingest-'+artifactHash+'.json'),bytes);
  write('input.json',{schema:'measured-acquisition.v1',artifactHash,runId:source.runId,inputAsOfMs:NOW,addresses:[ADDRESS],inputs:[sourceInput]});
  const perpDexs=[null,{name:'xyz'},{name:'flx'}],core=[{universe:[]},[]],xyz=[{universe:[{name:'xyz:X'}]},[]];
  write('markets.json',{perpDexs,core,xyz,startedAtMs:NOW,completedAtMs:NOW,rawSha256:[save(perpDexs,{type:'perpDexs'}),save(core,{type:'metaAndAssetCtxs'}),save(xyz,{type:'metaAndAssetCtxs',dex:'xyz'})]});
  const portfolio=[['month',{accountValueHistory:[],pnlHistory:[]}]];
  const allStates=['','xyz','flx'].map(dex=>{const state={assetPositions:[],tag:dex};return {dex,state,rawSha256:save(state,{type:'clearinghouseState',user:ADDRESS,...(dex?{dex}:{})}),startedAtMs:NOW,completedAtMs:NOW};});
  const portfolioHash=save(portfolio,{type:'portfolio',user:ADDRESS});
  const rows=[{coin:'BTC',tid:1,time:NOW-1,sz:'1',px:'100',startPosition:'0',side:'B',crossed:false}];
  const fillHash=save(rows,{type:'userFillsByTime',user:ADDRESS,startTime:NOW-100,endTime:NOW,aggregateByTime:false});
  write(ADDRESS+'.json',{address:ADDRESS,reads:[{address:ADDRESS,portfolio,states:allStates.slice(0,2).map(s=>s.state),allStates,
    stateCoverage:{complete:true,declaredDexes:['','xyz','flx'],requestedDexes:['','xyz','flx']},startedAtMs:NOW,completedAtMs:NOW,
    rawSha256:[...allStates.map(s=>s.rawSha256),portfolioHash]}],fills:{rows,startMs:NOW-100,endMs:NOW,complete:true,missingReasons:[],
    pages:[{requestStartMs:NOW-100,requestEndMs:NOW,count:1,firstFillMs:NOW-1,lastFillMs:NOW-1,rawSha256:fillHash}]}});
  if(journal){const db=new Database(join(directory,'budget.sqlite'));db.exec('CREATE TABLE request_attempts(body TEXT NOT NULL)');
    for(const row of attempts)db.query('INSERT INTO request_attempts VALUES(?)').run(JSON.stringify(row));db.close();}
  const edit=(name:string,change:(value:any)=>void)=>{const v=JSON.parse(readFileSync(join(directory,name),'utf8'));change(v);write(name,v);};
  return {directory,edit,portfolioHash};
}
test('binds exact source selection and all normalized public data to retained bytes and journal requests',()=>{
  const f=fixture(true);expect(verifyMeasuredArchive(f.directory)).toMatchObject({accounts:1,reads:1,completeAllDexReads:1,
    fillPages:1,scoreFinalistPrefixVerified:true,requestIdentity:'SQLITE_REQUEST_RESPONSE_VERIFIED',boundRequests:8});
});
test('reports raw-only verification honestly when request journal was not retained',()=>{
  expect(verifyMeasuredArchive(fixture().directory).requestIdentity).toBe('JOURNAL_UNAVAILABLE_RAW_CONTENT_ONLY');
});
test('rejects changed normalized input, portfolio, state, fills and forged all-DEX completeness',()=>{
  for(const [name,change,error]of [
    ['input.json',(v:any)=>{v.inputs[0].accountValue+=1;},'SOURCE_INPUT_BINDING'],
    [ADDRESS+'.json',(v:any)=>{v.reads[0].portfolio=[];},'PORTFOLIO_BINDING'],
    [ADDRESS+'.json',(v:any)=>{v.reads[0].allStates[2].state={assetPositions:[]};},'STATE_BINDING'],
    [ADDRESS+'.json',(v:any)=>{v.fills.rows[0].sz='2';},'NORMALIZED_FILL_BINDING'],
    [ADDRESS+'.json',(v:any)=>{v.reads[0].stateCoverage.declaredDexes=['','xyz'];},'DECLARED_DEX_BINDING'],
  ]as const){const f=fixture();f.edit(name,change);expect(()=>verifyMeasuredArchive(f.directory)).toThrow(error);}
});
test('rejects raw byte corruption and valid response bytes attributed to the wrong account',()=>{
  const f=fixture();writeFileSync(join(f.directory,'raw-'+f.portfolioHash+'.json'),'[]');
  expect(()=>verifyMeasuredArchive(f.directory)).toThrow('RAW_HASH');
  const g=fixture(true),db=new Database(join(g.directory,'budget.sqlite'));
  db.exec(`UPDATE request_attempts SET body=json_set(body,'$.request.user','different-account') WHERE json_extract(body,'$.request.type')='portfolio'`);db.close();
  expect(()=>verifyMeasuredArchive(g.directory)).toThrow('REQUEST_RESPONSE_BINDING');
});
test('legacy core/xyz response archives remain readable but cannot claim complete all-DEX evidence',()=>{
  const f=fixture(true);f.edit(ADDRESS+'.json',v=>{const r=v.reads[0];delete r.allStates;delete r.stateCoverage;r.rawSha256.splice(2,1);});
  expect(verifyMeasuredArchive(f.directory)).toMatchObject({legacyIncompleteReads:1,completeAllDexReads:0});
  f.edit(ADDRESS+'.json',v=>{v.reads[0].stateCoverage={complete:true};});expect(()=>verifyMeasuredArchive(f.directory)).toThrow('LEGACY_CANNOT_BE_COMPLETE');
});

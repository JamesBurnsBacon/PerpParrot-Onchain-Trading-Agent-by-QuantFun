import {test,expect} from 'bun:test';
import {PGlite} from '@electric-sql/pglite';
import {StrategyAgent,agentOptions,validateAnalysis,type Query,type AgentInput,type AgentOptions} from '../src/pipeline/strategy-agent';
import type {PacedInfo} from '../src/pipeline/hl';
import sample from './fixtures/score/portfolio-sample.json';

const address=(i:number)=>`0x${i.toString(16).padStart(40,'0')}`;
async function setup() {
  const db=new PGlite();const query:Query=async(q,p)=>(await db.query(q,p)).rows as Record<string,any>[];
  for(const file of ['20261007120000_pipeline.sql','20261007150000_pipeline_qualified.sql','20261007160000_strategy_analyses.sql','20261007160000_strategy_analyses.sql']) {
    await db.exec(await Bun.file(new URL(`../../../supabase/migrations/${file}`,import.meta.url)).text());
  }
  for(let i=1;i<=26;i++)await query(`insert into pipeline_accounts(address,source,kind,account_value,listed_at,portfolio,refreshed_at,trade_count,maker_share,orders_per_day,fills_at)
    values($1,$2,$3,20000,now(),$4::jsonb,now(),100,0.5,5,now())`,[address(i),i===25?'vault':'leaderboard',i===25?'hypercore-vault':'trader',JSON.stringify(sample[0].portfolio)]);
  const pick=async(ids=Array.from({length:25},(_,i)=>i+1))=>{
    const [{id}]=await query(`insert into selection_runs(started_at,status,finalists) values(now(),'rejected',$1::jsonb) returning id`,
      [JSON.stringify({finalists:ids.map(i=>({address:address(i),kind:i===25?'hypercore-vault':'trader',score:1,rank:i,metrics:{periodReturn:0.2}}))})]);return Number(id);
  };
  return {db,query,pick};
}
function modelRows(input:AgentInput) {
  return {candidates:input.candidates.map(c=>({candidate:c.candidate,strategy:'Possible directional exposure; ten-minute execution fit is unknown.',confidence:'low',
    evidence:[{field:'fillStats.makerShare',valueJson:'0.5',observation:'Half of observed notional is maker flow.'}],risks:['Sampled history can miss drawdowns.'],unknowns:['Entry signals and off-platform hedges.']}))};
}
function model(calls:AgentInput[],wait?:()=>Promise<void>,invalid=false):AgentOptions {
  return {apiKey:'test-key',model:'gpt-6-astra',fetcher:(async(_url,init)=>{
    const body=JSON.parse(String(init?.body)),input=JSON.parse(body.input);calls.push(input);
    expect(body.store).toBe(false);expect(body.reasoning.effort).toBe('high');expect(body.text.format.strict).toBe(true);
    expect(body.input).not.toContain('0x');if(wait)await wait();
    const result=modelRows(input);if(invalid)result.candidates[0].evidence[0].valueJson='0.9';
    return Response.json({id:'response-test',model:'gpt-6-astra',status:'completed',
      output:[{type:'message',content:[{type:'output_text',text:JSON.stringify(result)}]}],usage:{input_tokens:100,output_tokens:200,total_tokens:300}});
  }) as typeof fetch};
}
function positions(reads:string[]) {
  return ()=>({post:async<T>(body:Record<string,unknown>)=>{
    reads.push(`${body.user}:${body.dex??''}`);expect(body.type).toBe('clearinghouseState');
    const coins=body.dex?['xyz:GOLD','xyz:CL','xyz:BRENTOIL','xyz:XYZ100','xyz:TSLA','xyz:NVDA','xyz:SILVER']:['PAXG','BTC','ETH','SOL','HYPE','DOGE','ARB'];
    return {assetPositions:coins.map((coin,i)=>({position:{coin,szi:i===2?'-1':'1',positionValue:String((i+1)*100),leverage:{value:2},liquidationPx:null}}))} as T;
  }}) as Pick<PacedInfo,'post'>;
}

test('PGlite queue: unchanged/reordered picks reuse one job; changed set adds one; missing key stays queued',async()=>{
  const f=await setup();try{
    const agent=new StrategyAgent(f.query),id=await f.pick();
    expect((await agent.enqueue(id)).status).toBe('queued');
    expect((await agent.enqueue(id)).status).toBe('existing');
    const reordered=await f.pick(Array.from({length:25},(_,i)=>25-i));await agent.enqueue(reordered);
    expect((await f.query('select * from strategy_analyses')).length).toBe(1);
    await agent.enqueue(await f.pick(Array.from({length:25},(_,i)=>i+2)));
    expect((await agent.run()).status).toBe('waiting');
    const rows=await f.query('select * from strategy_analyses');expect(rows.length).toBe(2);
    expect(rows.every(r=>r.status==='queued'&&r.claim_token===null)).toBe(true);
    expect(agentOptions({})).toBeUndefined();
  }finally{await f.db.close();}
});

test('PGlite queue: overlapping workers call the model once, persist provenance, and join results by address',async()=>{
  const f=await setup();try{
    const calls:AgentInput[]=[],reads:string[]=[];let release!:()=>void,entered!:()=>void;
    const gate=new Promise<void>(r=>{release=r;}),started=new Promise<void>(r=>{entered=r;});
    const agent=new StrategyAgent(f.query,model(calls,async()=>{entered();await gate;}),positions(reads));
    const id=await f.pick();await agent.enqueue(id);
    const first=agent.run();await started;
    expect((await agent.run()).status).toBe('idle');release();expect((await first).status).toBe('complete');
    expect(calls.length).toBe(1);expect(reads.length).toBe(50);
    expect(calls[0].candidates.every(c=>(c.positions as unknown[]).length===12&&c.positionCount===14)).toBe(true);
    const c=calls[0].candidates[0],exposure=c.exposureByClass as Record<string,any>;
    expect(exposure.gold).toEqual({positionCount:2,longUsd:200,shortUsd:0,grossUsd:200,netUsd:200,markets:['PAXG','xyz:GOLD']});
    expect(exposure.oil.grossUsd).toBe(500);expect(exposure.oil.netUsd).toBe(-100);
    expect(exposure.crypto.positionCount).toBe(6);expect(exposure.other.positionCount).toBe(4);
    expect((c.positions as {market:string}[]).some(p=>p.market==='xyz:GOLD')).toBe(false); // still covered by aggregate
    expect(calls[0].candidates.filter(c=>c.kind==='hypercore-vault').length).toBe(1);
    const [saved]=await f.query('select * from strategy_analyses');expect(saved.input_hash).toHaveLength(64);
    expect(saved.result.economicAuthority).toBe(false);expect(saved.result.provider).toBe('openai');
    expect(saved.result.inputHash).toBe(saved.input_hash);expect(saved.result.usage.total_tokens).toBe(300);
    const picks=Array.from({length:25},(_,i)=>({address:address(25-i)}));
    const view=await agent.view(picks);expect(view!.candidates.length).toBe(25);
    expect(view!.candidates[24].address).toBe(address(25));expect(view).not.toHaveProperty('input');
    expect((await agent.run()).status).toBe('idle');expect(calls.length).toBe(1);
    expect((await f.query('select * from configurations')).length).toBe(0);
    expect((await f.query('select status from selection_runs where id=$1',[id]))[0].status).toBe('rejected');
  }finally{await f.db.close();}
});

test('PGlite queue: invalid model evidence fails once; missing config and expired workers never cause extra calls',async()=>{
  const f=await setup();try{
    const calls:AgentInput[]=[],agent=new StrategyAgent(f.query,model(calls,undefined,true),positions([]));
    await agent.enqueue(await f.pick());expect((await agent.run()).status).toBe('failed');
    expect((await agent.run()).status).toBe('idle');expect(calls.length).toBe(1);
    await agent.enqueue(await f.pick(Array.from({length:25},(_,i)=>i+2)));
    await f.query("update strategy_analyses set status='running',claim_token='old',claim_until=now()-interval '1 second' where status='queued'");
    expect((await agent.run()).status).toBe('idle');expect(calls.length).toBe(1);
    expect((await f.query('select status from strategy_analyses')).every(r=>r.status==='failed')).toBe(true);
  }finally{await f.db.close();}
});

test('PGlite queue: data is frozen at enqueue; catch-up finds a pick that missed the direct hook',async()=>{
  const f=await setup();try{
    const calls:AgentInput[]=[],agent=new StrategyAgent(f.query,model(calls),positions([]));
    await f.pick();expect((await new StrategyAgent(f.query).run()).status).toBe('waiting');
    await f.query('update pipeline_accounts set maker_share=0.9');
    expect((await agent.run()).status).toBe('complete');
    expect((calls[0].candidates[0].fillStats as any).makerShare).toBe(0.5);
    const [{n}]=await f.query("select count(*)::int n from pg_policies where tablename='strategy_analyses'");expect(n).toBe(0);
  }finally{await f.db.close();}
});

test('strict output: null/incorrect references, duplicate IDs, unknown fields and missing candidates reject',()=>{
  const input:AgentInput={selectedAt:new Date().toISOString(),candidates:Array.from({length:25},(_,candidate)=>({candidate,fillStats:{makerShare:0.5},missing:null}))};
  const missing=modelRows(input);missing.candidates[0].evidence[0].field='missing';expect(()=>validateAnalysis(missing,input)).toThrow();
  const duplicate=modelRows(input);duplicate.candidates[0].candidate=1;expect(()=>validateAnalysis(duplicate,input)).toThrow('candidate mismatch');
  expect(()=>validateAnalysis({...modelRows(input),weights:[]},input)).toThrow();
  const short=modelRows(input);short.candidates.pop();expect(()=>validateAnalysis(short,input)).toThrow();
});

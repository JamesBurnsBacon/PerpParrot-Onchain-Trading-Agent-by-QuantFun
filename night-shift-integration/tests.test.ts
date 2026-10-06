import {test,expect} from 'bun:test';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {Simulator,TransientError} from './simulator.ts';
import {VERSION,eventSchema,digest,runId,allocationSchema,type Event} from './contracts.ts';
import {allocate,candidates,windowStats,evaluate,DAY,type History} from './algorithms.ts';
import {probeModules} from './module-bridge.ts';
import {probeSchema} from './artifact-contracts.ts';
const event:Event={schemaVersion:VERSION,trigger:'REPLAY',bucketMs:1_800_000,sourceAsOfMs:1_800_000,
  sourceHash:'a'.repeat(64),codeHash:'b'.repeat(64),sourceKind:'SYNTHETIC_FIXTURE'};
const val=(x:unknown)=>{if(typeof x!=='number'||!Number.isFinite(x))throw Error('INVALID_NUMBER');return x;};
const temp=()=>mkdtempSync(join(tmpdir(),'night-simulator-'));
test('protocol rejects version drift, extra fields, future/stale sources and invalid capital totals',()=>{
  for(const e of [{...event,schemaVersion:'v2'},{...event,typo:1},{...event,sourceAsOfMs:event.bucketMs+1},
    {...event,sourceAsOfMs:1},{...event,bucketMs:event.bucketMs+1}])expect(()=>eventSchema.parse(e)).toThrow();
  expect(()=>allocationSchema.parse({schemaVersion:'night-allocation.v1',algorithm:'return-first.v1',cutoffMs:1,
    sources:[],eligible:0,cashWeight:0.9})).toThrow();
  expect(digest({b:2,a:1})).toBe(digest({a:1,b:2}));
  expect(()=>digest({x:NaN})).toThrow();
});
test('checkpoint survives injected failure; retry reuses committed work and preserves chain hash',async()=>{
  const dir=temp(),db=new Simulator(join(dir,'state.sqlite'));let calls=0;
  const work=async(run:any)=>{await run.step('first',{},async()=>{calls++;return 42;},val);await run.step('second',{parent:42},async()=>7,val);};
  try{
    await expect(db.run(event,work,{failAfter:'first'})).rejects.toThrow('INJECTED');
    const a=await db.run(event,work),b=await db.run(event,work);
    expect(calls).toBe(1);expect(a.steps[0].reused).toBe(true);expect(b.steps.every(x=>x.reused)).toBe(true);
    expect(a.artifactChainHash).toBe(b.artifactChainHash);
    expect(db.db.query('SELECT count(*) as n FROM events').get()).toEqual({n:2});
    await expect(db.run(event,async run=>{await run.step('first',{changed:true},async()=>42,val);})).rejects.toThrow('CONFLICT');
  }finally{db.close();rmSync(dir,{recursive:true,force:true});}
});
test('SIGKILL leaves recoverable ownership and a committed checkpoint',async()=>{
  const dir=temp(),path=join(dir,'state.sqlite');
  const child=Bun.spawn([process.execPath,'--no-env-file',join(import.meta.dir,'crash-child.ts'),path],{stdout:'ignore',stderr:'pipe'});
  await child.exited;const db=new Simulator(path);let called=false;
  try{
    const result=await db.run(event,async run=>{
      const first=await run.step('first',{},async()=>{called=true;return {value:0};},x=>x as {value:number});
      expect(first.value).toBe(42);await run.step('second',first,async()=>1,val);
    });
    expect(called).toBe(false);expect(result.status).toBe('SUCCEEDED');
  }finally{db.close();rmSync(dir,{recursive:true,force:true});}
});
test('bounded transient retry, timeout, concurrent owner and checkpoint corruption',async()=>{
  const dir=temp(),db=new Simulator(join(dir,'state.sqlite'));let tries=0;
  try{
    await db.run(event,async run=>{await run.step('retry',{},async()=>{if(++tries<3)throw new TransientError('LOCAL_TEMPORARY');return 9;},val,{retryTransient:2});});
    expect(tries).toBe(3);
    let release!:()=>void;const pending=new Promise<void>(r=>release=r);
    const first=db.run({...event,sourceHash:'c'.repeat(64)},async()=>pending);
    await expect(db.run({...event,sourceHash:'c'.repeat(64)},async()=>{})).rejects.toThrow('BUSY');release();await first;
    await expect(db.run({...event,sourceHash:'d'.repeat(64)},async run=>{
      await run.step('hang',{},async()=>new Promise<number>(()=>{}),val,{timeoutMs:10});
    })).rejects.toThrow('TIMEOUT');
    db.db.query("UPDATE stages SET artifact=replace(artifact,'\"body\":9','\"body\":8') WHERE stage='retry'").run();
    await expect(db.run(event,async run=>{await run.step('retry',{},async()=>9,val);})).rejects.toThrow('CORRUPT');
  }finally{db.close();rmSync(dir,{recursive:true,force:true});}
});
test('a permanent validation error is not retried; a TICK cannot replay an old archive',async()=>{
  const dir=temp(),db=new Simulator(join(dir,'state.sqlite'));let calls=0;
  try{
    await expect(db.run(event,async run=>{await run.step('invalid',{},async()=>{calls++;return NaN;},val,{retryTransient:2});})).rejects.toThrow('INVALID_NUMBER');
    expect(calls).toBe(1);
    expect(db.db.query('SELECT artifact FROM stages').get()).toEqual({artifact:null});
    await expect(db.run({...event,trigger:'TICK'},async()=>{})).rejects.toThrow('CLOCK');
  }finally{db.close();rmSync(dir,{recursive:true,force:true});}
});
test('deposit-aware returns, no future selection leakage, missing test coverage never replaces a selected source',()=>{
  const from=Date.UTC(2026,0,1),points=[{ts:from,accountValue:100,pnl:0},
    {ts:from+DAY,accountValue:1100,pnl:100},{ts:from+2*DAY,accountValue:1100,pnl:100},{ts:from+3*DAY,accountValue:1100,pnl:100}];
  expect(windowStats(points,from,from+3*DAY)!.periodReturn).toBeCloseTo(0.1);
  const histories:History[]=Array.from({length:6},(_,j)=>({address:'0x'+String(j+1).repeat(40),points:Array.from({length:51},(_,i)=>
    ({ts:from+i*DAY,accountValue:20_000+i*(10+j),pnl:i*(10+j)}))}));
  const cut=from+30*DAY,a=allocate(candidates(histories,cut),'return-first.v1',cut);
  const changed=structuredClone(histories);for(const h of changed)for(const p of h.points)if(p.ts>cut){p.pnl*=1e5;p.accountValue*=1e5;}
  expect(allocate(candidates(changed,cut),'return-first.v1',cut)).toEqual(a);
  expect(allocate(candidates([...histories].reverse(),cut),'return-first.v1',cut)).toEqual(a);
  expect(evaluate(a,histories.filter(h=>h.address!==a.sources[0].address),from+50*DAY).status).toBe('INCOMPLETE');
});
test('both rule adapters use production Score, Review, database, freeze, HTTP targets and durable executor contracts',async()=>{
  const dir=temp();
  try{
    for(const algorithm of ['return-first.v1','drawdown-first.v1'] as const){
      const result=probeSchema.parse(await probeModules(join(dir,algorithm),algorithm,1_791_301_200_000));
      expect(result.reviewStatus).toBe('VALID');expect(result.auditRows).toBe(3);
      expect(result.afterFreezePhase).toBe('MONITOR');expect(result.plan.orders.length).toBe(5);
      const resumed=probeSchema.parse(await probeModules(join(dir,algorithm),algorithm,1_791_301_200_000));
      expect(digest(result)).toBe(digest(resumed));
    }
  }finally{rmSync(dir,{recursive:true,force:true});}
},60_000);

import { readFileSync, writeFileSync, mkdirSync, renameSync, readdirSync, statSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { z } from 'zod';
import { spawnSync } from 'node:child_process';
import type { ScoreInput } from '../packages/backend/src/score/types.ts';
import { checkBacktestArtifact, checkFunnelArtifact, type BacktestArtifact } from '../packages/shared/dashboard.ts';
import { ALGORITHMS, WINDOWS, DAY, history, candidates, allocate, evaluate, type History } from './algorithms.ts';
import { byteDigest, digest, eventSchema, VERSION, BUCKET_MS, runId, allocationSchema } from './contracts.ts';
import { Simulator } from './simulator.ts';
import { probeModules } from './module-bridge.ts';
import { probeSchema, dashboardBundleSchema } from './artifact-contracts.ts';

export const ROOT=resolve(import.meta.dir,'..');
const LAB=join(ROOT,'night-shift-integration');
export const DEFAULT_DATA=join(ROOT,'local-score-data');
const point=z.tuple([z.number().int().positive(),z.number().finite()]);
const windowSchema=z.object({accountValueHistory:z.array(point),pnlHistory:z.array(point)}).strict();
export const inputSchema=z.object({address:z.string().regex(/^0x[0-9a-f]{40}$/),kind:z.enum(['trader','hypercore-vault','erc4626-vault']),
  accountValue:z.number().finite().nonnegative(),closed:z.boolean().nullable(),month:windowSchema.nullable(),allTime:windowSchema.nullable(),history:windowSchema.nullable(),
  tradeCount:z.number().int().nonnegative().nullable(),links:z.array(z.string()).optional(),avgLeverage:z.number().finite().nullable().optional(),
  timeInMarket:z.number().finite().nullable().optional(),medianHoldHours:z.number().finite().nullable().optional(),makerShare:z.number().finite().nullable().optional()}).strict();
export function loadArchive(dataDir:string) {
  const manifest=JSON.parse(readFileSync(join(dataDir,'manifest.json'),'utf8'));
  const file='score-inputs.jsonl.gz',bytes=readFileSync(join(dataDir,file));
  const expected=manifest.files.find((x:any)=>x.file===file);
  if(!expected||byteDigest(bytes)!==expected.sha256)throw new Error('ARCHIVE_CHECKSUM_MISMATCH');
  const inputs=gunzipSync(bytes).toString('utf8').trim().split('\n').map(line=>inputSchema.parse(JSON.parse(line))) as ScoreInput[];
  if(inputs.length!==expected.rows||new Set(inputs.map(i=>i.address)).size!==inputs.length)throw new Error('ARCHIVE_COUNT_OR_DUPLICATE');
  const histories=inputs.map(history).filter((x):x is History=>x!==null);
  return {manifest,inputs,histories,sourceHash:byteDigest(bytes),sourceAsOfMs:Date.parse(manifest.exportedAt)};
}
export function codeIdentity() {
  const tracked=spawnSync('git',['ls-files','packages','tests/support','supabase/migrations','package.json','pnpm-lock.yaml','tsconfig.json'],{cwd:ROOT,encoding:'utf8'});
  if(tracked.status!==0)throw new Error('GIT_INVENTORY_FAILED');
  const labFiles=readdirSync(LAB).filter(f=>f.endsWith('.ts')||['package.json','tsconfig.json'].includes(f));
  const paths=[...tracked.stdout.trim().split('\n').filter(p=>(/\.(ts|tsx|json|sql)$/.test(p)||p.endsWith('bun.lock')||p==='pnpm-lock.yaml')&&!/(^|\/)(\.env|secrets|keystore)/i.test(p)),...labFiles.map(f=>'night-shift-integration/'+f)].sort();
  return digest(paths.map(p=>[p,byteDigest(readFileSync(join(ROOT,p)))]));
}
const finite=z.number().finite();
const curveSchema=z.array(z.tuple([z.number().int().positive(),finite]));
const evaluationSchema=z.object({schemaVersion:z.literal('night-evaluation.v1'),sourceKind:z.literal('REAL_ARCHIVE'),
  economicAuthority:z.literal(false),asOfMs:z.number().int().positive(),inputs:z.number().int(),usableHistories:z.number().int(),
  limitations:z.array(z.string()),windows:z.array(z.object({days:z.number().int(),allocation:allocationSchema,
    result:z.object({status:z.enum(['COMPLETE','INCOMPLETE']),missing:z.array(z.string()),curve:curveSchema,periodReturn:finite.nullable(),maxDrawdown:finite.nullable(),
      observationSpans:z.array(z.object({address:z.string(),startMs:z.number().int(),endMs:z.number().int(),coveredDays:finite}).strict()).optional()}).strict(),
  }).strict()).length(8)}).strict();

export function runEvaluations(archive:ReturnType<typeof loadArchive>) {
  // Common completed UTC day. The snapshot itself is a survivor-selected research universe.
  const asOfMs=Math.floor(archive.sourceAsOfMs/DAY)*DAY;
  return evaluationSchema.parse({schemaVersion:'night-evaluation.v1',sourceKind:'REAL_ARCHIVE',economicAuthority:false,asOfMs,
    inputs:archive.inputs.length,usableHistories:archive.histories.length,
    limitations:['Current research shortlist: survivorship and retrospective cohort bias remain.',
      'Training uses only points before each cut; candidate membership was discovered later.',
      'Sparse samples: no interpolation across cutoff; boundary intervals excluded; sampling can hide drawdown.',
      'Fixed source sleeves; 20% cash; assumed 10 bps entry and 10 bps exit on invested capital; no fills/latency simulation.',
      'Deterministic baselines, not two AI models or evidence of an investable winner.'],
    windows:WINDOWS.flatMap(days=>{
      const cutoff=asOfMs-days*DAY,pool=candidates(archive.histories,cutoff);
      return ALGORITHMS.map(algorithm=>{const allocation=allocate(pool,algorithm,cutoff);
        return {days,allocation,result:evaluate(allocation,archive.histories,asOfMs)};});
    })});
}
export function dashboardArtifacts(evaluation:ReturnType<typeof runEvaluations>,btcPath:string) {
  const btc=JSON.parse(readFileSync(btcPath,'utf8'));
  if(btc.request?.type!=='candleSnapshot'||btc.request?.req?.coin!=='BTC'||!Array.isArray(btc.data))throw new Error('INVALID_BTC_SOURCE');
  const candles=btc.data.map((c:any)=>({ts:Number(c.T)+1,price:Number(c.c)})).filter((c:any)=>Number.isSafeInteger(c.ts)&&Number.isFinite(c.price)&&c.price>0).sort((a:any,b:any)=>a.ts-b.ts);
  const artifacts=WINDOWS.map(days=>{
    const rows=evaluation.windows.filter(w=>w.days===days),cutoff=rows[0].allocation.cutoffMs;
    const baseline=candles.filter((c:any)=>c.ts<=cutoff).at(-1),end=candles.filter((c:any)=>c.ts<=evaluation.asOfMs).at(-1);
    if(!baseline||cutoff-baseline.ts>DAY||!end||evaluation.asOfMs-end.ts>DAY)throw new Error('BTC_COVERAGE_MISSING');
    const points:[number,number][]=[[cutoff,1],...candles.filter((c:any)=>c.ts>cutoff&&c.ts<=evaluation.asOfMs).map((c:any)=>[c.ts,c.price/baseline.price] as [number,number])];
    const artifact:BacktestArtifact={generatedAt:evaluation.asOfMs,window:`${days} days — nightly integration baseline`,
      series:[...rows.filter(r=>r.result.status==='COMPLETE').map(r=>({id:r.allocation.algorithm,label:r.allocation.algorithm,points:r.result.curve})),{id:'btc',label:'BTC perpetual close-price benchmark (not spot total return)',points}]};
    const errors=checkBacktestArtifact(artifact);if(errors.length)throw new Error(errors.join(';'));
    return {days,artifact};
  });
  const shortlist=evaluation.windows.find(w=>w.days===30&&w.allocation.algorithm===ALGORITHMS[0])!.allocation;
  const funnel={generatedAt:evaluation.asOfMs,steps:[{stage:'archive',label:'Archived Score inputs',count:evaluation.inputs},
    {stage:'histories',label:'Usable histories',count:evaluation.usableHistories},{stage:'training',label:'30-day training candidates',count:shortlist.eligible},
    {stage:'selected',label:'Rule A research selection; not frozen',count:shortlist.sources.length}],
    finalists:shortlist.sources.map((s,i)=>({address:s.address,kind:'research-candidate',score:1-i/5,picked:false,rationale:'Rule A research rank only; not production Score and not a frozen source'}))};
  const errors=checkFunnelArtifact(funnel);if(errors.length)throw new Error(errors.join(';'));
  return {artifacts,funnel};
}
export async function runPipeline(options:{dataDir?:string;out?:string;btc?:string;ticks?:number;failAfter?:string}) {
  const out=resolve(options.out??join(LAB,'out')),archive=loadArchive(options.dataDir??DEFAULT_DATA);
  mkdirSync(out,{recursive:true});
  const codeHash=codeIdentity(),btcPath=resolve(options.btc??join(LAB,'out/btc-candles.json'));
  const benchmarkHash=byteDigest(readFileSync(btcPath));
  const sourceHash=digest({archive:archive.sourceHash,benchmark:benchmarkHash});
  const receipts=[];
  for(let i=0;i<(options.ticks??2);i++) {
    const event=eventSchema.parse({schemaVersion:VERSION,trigger:'REPLAY',sourceKind:'REAL_ARCHIVE',sourceHash,codeHash,
      sourceAsOfMs:archive.sourceAsOfMs,bucketMs:Math.ceil(archive.sourceAsOfMs/BUCKET_MS)*BUCKET_MS+i*BUCKET_MS});
    const id=runId(event),dir=join(out,id);mkdirSync(dir,{recursive:true});
    const runtime=new Simulator(join(out,'simulator.sqlite'));
    try {
      const receipt=await runtime.run(event,async run=>{
        const ingested=await run.step('ingest',{sourceHash},async()=>({sourceHash,archiveHash:archive.sourceHash,benchmarkHash,
          count:archive.inputs.length,sourceAsOfMs:archive.sourceAsOfMs}),x=>z.object({sourceHash:z.string(),archiveHash:z.string(),benchmarkHash:z.string(),count:z.number().int(),sourceAsOfMs:z.number().int()}).strict().parse(x));
        const evaluations=await run.step('evaluate',ingested,async()=>runEvaluations(archive),x=>evaluationSchema.parse(x));
        const artifacts=await run.step('dashboard',{evaluationHash:digest(evaluations),benchmarkHash},async()=>dashboardArtifacts(evaluations,btcPath),x=>{
          const v=dashboardBundleSchema.parse(x);
          if(v.artifacts.length!==4||checkFunnelArtifact(v.funnel).length||v.artifacts.some(a=>checkBacktestArtifact(a.artifact).length))throw new Error('DASHBOARD_CONTRACT');return v;
        });
        writeJson(join(dir,'evaluation.json'),evaluations);
        writeJson(join(dir,'funnel.json'),artifacts.funnel);
        for(const a of artifacts.artifacts)writeJson(join(dir,`backtest-${a.days}d.json`),a.artifact);
        for(const algorithm of ALGORITHMS){
          const stage=algorithm.split('.')[0];
          const probe=await run.step(stage,{parentEvaluationHash:digest(evaluations),algorithm,sourceKind:'SYNTHETIC_FIXTURE'},
            async()=>probeModules(join(dir,stage+'-paper-db'),algorithm,event.bucketMs),x=>{
              const v=probeSchema.parse(x);
              if(v.algorithm!==algorithm||v.allocation.algorithm!==algorithm)throw new Error('ALGORITHM_BINDING_MISMATCH');
              return v;
            });
          writeJson(join(dir,stage+'-probe.json'),probe);
        }
      },{failAfter:options.failAfter});
      writeJson(join(dir,'event.json'),event);
      receipts.push({...receipt,event});writeJson(join(dir,'receipt.json'),receipts.at(-1));
      const files=readdirSync(dir).filter(f=>f.endsWith('.json')).sort();
      writeFileSync(join(dir,'SHA256SUMS'),files.map(f=>byteDigest(readFileSync(join(dir,f)))+'  '+f).join('\n')+'\n');
      console.log(JSON.stringify({runId:id,status:receipt.status,stages:receipt.steps.length,reused:receipt.steps.filter(s=>s.reused).length}));
    }finally{runtime.close();}
  }
  writeJson(join(out,'latest.json'),{schemaVersion:'night-delivery.v1',economicAuthority:false,codeHash,sourceHash,receipts});
  return {out,receipts};
}
export function writeJson(path:string,value:unknown){const tmp=path+'.tmp';writeFileSync(tmp,JSON.stringify(value,null,2)+'\n');renameSync(tmp,path);}

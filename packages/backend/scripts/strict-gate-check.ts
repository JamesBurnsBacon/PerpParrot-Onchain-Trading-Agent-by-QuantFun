// Measures the AI review's strict gate on live data (docs/agents/STRICT_GATE_PLAN.md): leaderboard
// traders + hyperliquidvaults.com vaults → Score's 40 finalists → measured evidence → Role, Risk
// and Red-Team (real model calls) → the review core's verdict, with REVIEW_GATE=strict. Prints
// each finalist's model scores next to its measured evidence. Read-only on Hyperliquid; writes
// only to the local Postgres you give it (apply supabase/migrations first). Never trades.
//
//   OPENAI_API_KEY=… DATABASE_URL=postgres://…local… bun run scripts/strict-gate-check.ts \
//     [--traders 40] [--vaults 40] [--inputs cache.json] [--gate strict|basic]
//
// --inputs caches the fetched accounts (the slow part, ~5 min) so reruns only redo the review.
import { parseArgs } from "node:util";
import {rename} from 'node:fs/promises';
import { SQL } from "bun";
import {localReviewDb} from './local-review-db';
import {kimiPaperCommittee} from '../review/models/kimi-paper';
import {openAIPaperCommittee} from '../review/models/openai-paper';
import {commitment} from '../../shared/src/commitments.ts';
import {candidateGate} from '../review/workflow';
import type {Frame,Policy,Row} from '../../shared/src/contracts.ts';
import { Pipeline, reviewPolicy } from "../src/pipeline";
import { fillStats, isHighFrequency, pickLeaderboard, type LeaderboardRow } from "../src/pipeline/derive";
import { pickVaults } from "../src/pipeline/vaults";
import { PacedInfo, getJson } from "../src/pipeline/hl";
import { parsePortfolio, scoreCandidates, type ScoreInput } from "../src/score";

// The isolated research-runtime builder changes these two limits only in its copy.
const MAX_RESEARCH_FINALISTS=40,MAX_RESEARCH_TIMEOUT_MS=180000;
const { values } = parseArgs({
  options: {
    traders: { type: "string", default: "40" },
    vaults: { type: "string", default: "40" },
    inputs: { type: "string" },
    gate: { type: "string", default: "strict" },
    model: {type:"string"},
    "local-dir": {type:"string"},
    reads: {type:"string"},
    output: {type:"string"},
    "as-of": {type:"string"},
    finalists: {type:"string",default:"40"},
    serial: {type:"boolean",default:false},
    "stage-spacing-ms": {type:"string",default:"0"},
    "replay-run": {type:"string"},
    provider: {type:"string",default:"openai"},
    offline: {type:"boolean",default:false},
    "prepare-only": {type:"boolean",default:false},
    "timeout-ms": {type:"string",default:"180000"},
    "risk-reject-threshold": {type:"string"},
  },
});
const url=process.env.DATABASE_URL;
if(!values['local-dir']&&(!url||!['localhost','127.0.0.1','[::1]'].includes(new URL(url).hostname)))
  throw new Error('Use --local-dir or a loopback DATABASE_URL; remote databases are forbidden');
if(!['openai','kimi'].includes(values.provider!))throw new Error('unknown provider');
const localResearch=values['replay-run']||values.provider==='kimi'||values.offline||values['prepare-only']||values['timeout-ms']!=='180000'||values.finalists!=='40'||values.serial||values['stage-spacing-ms']!=='0'||values['risk-reject-threshold']!==undefined;
if(localResearch&&!values['local-dir'])throw new Error('Research flags require --local-dir; no external database allowed');
if(values.offline&&(!values.reads||!values.inputs||!values['as-of']))throw new Error('--offline requires reads, inputs and as-of');
const apiKey=values.provider==='kimi'?process.env.MOONSHOT_API_KEY:process.env.OPENAI_API_KEY;
if(!apiKey&&!values['prepare-only'])throw new Error('provider API key is required');
const model=values.model??(values.provider==='kimi'?'kimi-k3':process.env.REVIEW_MODEL??'gpt-6-sol');
const threshold=values['risk-reject-threshold']===undefined?null:Number(values['risk-reject-threshold']);
if(threshold!==null&&(!Number.isInteger(threshold)||threshold<1||threshold>100))throw new Error('risk reject threshold must be an integer from 1 to 100');
const policy={...reviewPolicy(await Bun.file(new URL('../fixtures/review-policy.json',import.meta.url)).json()),...(threshold===null?{}:{riskRejectThreshold:threshold})};
const timeoutMs=Number(values['timeout-ms']);
const finalists=Number(values.finalists),spacingMs=Number(values['stage-spacing-ms']);
if(!Number.isSafeInteger(finalists)||finalists<5||finalists>MAX_RESEARCH_FINALISTS)throw new Error('unsupported finalist count; an expanded count requires the isolated research runtime');
if(!Number.isSafeInteger(spacingMs)||spacingMs<0||spacingMs>120000||spacingMs>0&&!values.serial)throw new Error('spacing requires serial and 0..120000ms');
if(!Number.isSafeInteger(timeoutMs)||timeoutMs<1000||timeoutMs>MAX_RESEARCH_TIMEOUT_MS)throw new Error('unsupported timeout; extended waits require the isolated research runtime');
// The local adapter implements the tagged reads/writes/transactions used by review(), not Bun's full driver.
const sql=values['local-dir']?await localReviewDb(values['local-dir']) as unknown as SQL:new SQL(url!);
// Reuse identical public reads for same-input model comparisons. Never cache keys or model calls.
const reads:Record<string,unknown>=values.reads&&await Bun.file(values.reads).exists()?await Bun.file(values.reads).json():{};
if(values['replay-run']&&!values.offline)throw new Error('Replaying validated stages requires offline evidence');
const replay=values['replay-run']?await Bun.file(values['replay-run']).json():undefined;
if(replay&&(replay.report?.preparedOnly||replay.report?.requestedModel!==model||replay.report?.provider!==values.provider))throw new Error('replay model mismatch');
const replayHash=replay?commitment('perpparrot:research-replay:v1',replay):undefined;
const modelCalls:Record<string,unknown>[]=[];
const replayedStages:string[]=[];
const preparedRequests:unknown[]=[];
const cacheMisses:string[]=[];
const stageFailures:{stage:string;error:string;message:string}[]=[];
let saveReads=Promise.resolve();
const realFetch=globalThis.fetch;
globalThis.fetch=(async(input:Parameters<typeof fetch>[0],init?:RequestInit)=>{
  const url=String(input instanceof Request?input.url:input);
  const publicRead=/^https:\/\/(api.hyperliquid.xyz|stats-data.hyperliquid.xyz|hyperliquidvaults.com)\//.test(url);
  const key=JSON.stringify([url,init?.body??'']);
  if(publicRead&&Object.hasOwn(reads,key))return Response.json(reads[key]);
  if(publicRead&&values.offline){cacheMisses.push(commitment('perpparrot:research-cache-key:v1',key));throw new Error('offline public-read cache miss');}
  const isModel=['https://api.openai.com/v1/chat/completions','https://api.moonshot.cn/v1/chat/completions'].includes(url);
  if(isModel){
    const request=JSON.parse(String(init?.body)),user=JSON.parse(request.messages[1].content);
    const entry:Record<string,unknown>={requestedModel:request.model,stage:request.response_format.json_schema.name,
      reasoningEffort:request.reasoning_effort??null,maxCompletionTokens:request.max_completion_tokens,
      evidenceHash:user.evidence.evidenceHash,policyHash:user.evidence.policyHash,snapshotHash:user.evidence.snapshotHash,
      promptHash:commitment('perpparrot:prompt:v1',request.messages[0].content),
      schemaHash:commitment('perpparrot:research-schema:v1',request.response_format),userMessageHash:commitment('perpparrot:research-user:v1',request.messages[1].content),
      requestBytes:new TextEncoder().encode(String(init?.body)).length,finalists:user.evidence.finalists.length,preparedOnly:values['prepare-only']};
    modelCalls.push(entry);
    if(values['prepare-only']){preparedRequests.push(request);return Response.json({error:{message:'prepare only; no provider contacted'}},{status:503});}
    if(cacheMisses.length)throw new Error('incomplete offline evidence; refusing paid request');
    const started=performance.now();
    try{
      let response:Response;
      for(let attempt=0;;attempt++){
        response=await realFetch(input,init);
        if(response.status!==429||attempt===3)break;
        entry.rateLimitRetries=attempt+1;
        const retryAfter=Number(response.headers.get('retry-after'));
        await response.body?.cancel();
        await Bun.sleep(Number.isFinite(retryAfter)&&retryAfter>0?Math.min(retryAfter*1000,20_000):[1_000,3_000,10_000][attempt]);
        if(init?.signal?.aborted)throw init.signal.reason;
      }
      entry.httpStatus=response.status;
      const result=await response.clone().json() as {model?:string;usage?:unknown;choices?:{finish_reason:string}[];error?:{code?:string;type?:string;message?:string}};
      Object.assign(entry,{model:result.model,usage:result.usage,finishReason:result.choices?.[0]?.finish_reason,errorCode:result.error?.code,errorType:result.error?.type,errorMessage:result.error?.message?.slice(0,400)});
      return response;
    }catch(error){entry.transportError=error instanceof Error?error.name:'unknown';throw error;}
    finally{entry.elapsedMs=Math.round(performance.now()-started);}
  }
  const response=await realFetch(input,init);
  if(publicRead&&response.ok&&response.headers.get('content-type')?.includes('json')){
    reads[key]=await response.clone().json();
    if(values.reads){
      const path=values.reads;
      saveReads=saveReads.then(async()=>{await Bun.write(`${path}.tmp`,JSON.stringify(reads));await rename(`${path}.tmp`,path);});
      await saveReads;
    }
  }
  return response;
}) as typeof fetch;
class ReadCachedInfo extends PacedInfo {
  override async post<T>(body:Record<string,unknown>,weight=20,items?:(value:T)=>number):Promise<T>{
    const key=JSON.stringify(['https://api.hyperliquid.xyz/info',JSON.stringify(body)]);
    if(Object.hasOwn(reads,key))return structuredClone(reads[key]) as T;
    if(values.offline){cacheMisses.push(commitment('perpparrot:research-cache-key:v1',key));throw new Error('offline public-read cache miss');}
    return super.post(body,weight,items); // all online cache misses remain rate limited
  }
}
const log = (m: string, d?: object) => console.log(new Date().toISOString().slice(11, 19), m, JSON.stringify(d ?? {}).slice(0, 300));
const now = values["as-of"] ? Date.parse(values["as-of"]) : Date.now();
if(!Number.isSafeInteger(now))throw new Error("invalid --as-of");
const cache = values.inputs ? Bun.file(values.inputs) : undefined;
let inputs: (ScoreInput & {ordersPerDay?:number|null})[] = cache && (await cache.exists()) ? await cache.json() : [];
if (inputs.length === 0 && values.offline)throw new Error('offline inputs cache is empty');
if (inputs.length === 0) {
  const vaults = await pickVaults(now, log);
  const board = await getJson<{ leaderboardRows: LeaderboardRow[] }>("https://stats-data.hyperliquid.xyz/Mainnet/leaderboard");
  const traders = pickLeaderboard(board.leaderboardRows, Number(values.traders), new Set(vaults.map((v) => v.address)));
  const hl = new ReadCachedInfo(900);
  for (const t of [...traders, ...vaults.slice(0, Number(values.vaults))]) {
    try {
      const portfolio = await hl.post<unknown>({ type: "portfolio", user: t.address });
      const fills = await hl.post<Parameters<typeof fillStats>[0]>({ type: "userFillsByTime", user: t.address, startTime: now - 30 * 86_400_000, aggregateByTime: true }, 20, (f) => f.length);
      const { tradeCount, makerShare, ordersPerDay } = fillStats(fills, now);
      inputs.push({ address: t.address, kind: t.kind, accountValue: t.accountValue, closed: t.closed, ...parsePortfolio(portfolio), history: null, tradeCount, makerShare,ordersPerDay });
      if(inputs.length%10===0)log('fetched',{accounts:inputs.length});
    } catch (e) {
      log("skipped", { address: t.address, error: (e as Error).message });
    }
  }
  if (cache) await Bun.write(cache, JSON.stringify(inputs));
}
log("accounts", { count: inputs.length });
// Match select()'s no-HFT screen. Old input caches lacked the observed order-rate field.
const statsHl=new ReadCachedInfo(600);
for(const input of inputs)if(input.ordersPerDay===undefined){
  const fills=await statsHl.post<Parameters<typeof fillStats>[0]>({type:'userFillsByTime',user:input.address,startTime:now-30*86_400_000,aggregateByTime:true},20,f=>f.length);
  Object.assign(input,fillStats(fills,now));
}
if(cache)await Bun.write(cache,JSON.stringify(inputs));
const selectedInputs=inputs.filter(input=>!isHighFrequency(input.ordersPerDay??null));
const highFrequency=inputs.length-selectedInputs.length;
log('no-HFT screen',{excluded:highFrequency,scored:selectedInputs.length});
const result = scoreCandidates(selectedInputs, { finalists });
const pipeline = new Pipeline({
  sql,
  now:()=>now,
  info:perMinute=>new ReadCachedInfo(perMinute),
  account: "0x7269502c48c582768ee38e4e71e7572e6ebf70f7",
  policy,
  openAiKey: apiKey??'prepare-only-no-key',
  paperCommittee:(options,core)=>{
    const deps=(values.provider==='kimi'?kimiPaperCommittee:openAIPaperCommittee)(options,{...core,agentTimeoutMs:timeoutMs});
    const replayStage=(stage:'role'|'risk'|'redteam',evidence:{evidenceHash:string},draftHash?:string)=>{
      const record=replay?.run?.review?.audit?.find((r:{stage:string;draftHash?:string})=>r.stage===stage&&r.draftHash===draftHash);
      if(!record)return undefined;
      const output=record.output;
      const call=replay.report.modelCalls.find((c:{stage:string})=>c.stage===`paper_${stage}`);
      const promptHash=stage==='role'?deps.rolePromptHash:stage==='risk'?deps.riskPromptHash:deps.redTeamPromptHash;
      if(!call||call.preparedOnly||call.model!==model||call.finishReason!=='stop'||record.evidenceHash!==evidence.evidenceHash||output.evidenceHash!==evidence.evidenceHash||output.modelConfigHash!==deps.modelConfigHash||output.promptHash!==promptHash)
        throw new Error('replay evidence/model/prompt mismatch');
      modelCalls.push({...call,replayed:true,replayRunHash:replayHash});replayedStages.push(stage);
      return [structuredClone(output)]; // The bridge independently revalidates schema, IDs and binding.
    };
    let queue=Promise.resolve(),lastStart=0;
    const wrap=<Args extends unknown[],Result>(stage:string,fn:(...args:Args)=>Promise<Result>)=>(...args:Args)=>{
      const call=async()=>{
        if(values.serial){const delay=Math.max(0,lastStart+spacingMs-Date.now());if(delay)await Bun.sleep(delay);lastStart=Date.now();}
        try{return await fn(...args);}
        catch(error){stageFailures.push({stage,error:error instanceof Error?error.name:'unknown',message:error instanceof Error?error.message.slice(0,500):'unknown'});throw error;}
      };
      if(!values.serial)return call();
      const next=queue.then(call);queue=next.then(()=>{},()=>{});return next;
    };
    const role=wrap('role',deps.role),risk=wrap('risk',deps.risk),red=wrap('redTeam',deps.redTeam);
    deps.role=async(evidence,signal)=>replayStage('role',evidence)??role(evidence,signal);
    deps.risk=async(evidence,signal)=>replayStage('risk',evidence)??risk(evidence,signal);
    deps.redTeam=async(draft,signal)=>replayStage('redteam',draft.evidence,draft.draftHash)??red(draft,signal);
    return deps;
  },
  model,
  gate: values.gate === "basic" ? "basic" : "strict",
  log,
});
const [{ id }] = await sql`insert into selection_runs (started_at, status, accounts) values (now(), 'running', ${inputs.length}) returning id`;
// review() is the pipeline's selection step after Score (private; this script is its harness).
let outcome:unknown;
try {outcome=await (pipeline as unknown as { review: (...a: unknown[]) => Promise<unknown> }).review(Number(id), selectedInputs, result, highFrequency);}
catch(error){outcome={status:'failed',reason:(error as Error).message};}
console.log(outcome);

const [run] = await sql`select finalists -> 'measured' as measured, finalists -> 'additional' as additional, review from selection_runs where id = ${id}`;
const rows = new Map<number, Record<string, Record<string, unknown>>>();
for (const record of (run.review?.audit ?? []) as { stage: string; output: { results?: Record<string, unknown>[] } }[])
  for (const r of record.output.results ?? []) rows.set(Number(r.candidate), { ...rows.get(Number(r.candidate)), [record.stage]: r });
const n = (x: unknown, digits = 0) => (typeof x === "number" ? x.toFixed(digits) : "–");
console.log("\ncand address     | role: fit conf rej | risk: conf dd lev conc path exec evid | hold-min lev oosSh stab cov fit");
for (const s of (run.review?.summary ?? []) as { candidate: number; address: string }[]) {
  const role = rows.get(s.candidate)?.role ?? {};
  const risk = rows.get(s.candidate)?.risk ?? {};
  const m = (run.measured as Record<string, Record<string, number | null>>)[s.address] ?? {};
  console.log(
    `c${s.candidate}`.padEnd(5), s.address.slice(0, 10), "|", role.aggressiveFit, role.confidence, role.reject, "|",
    risk.confidence, risk.drawdownRisk, risk.leverageRisk, risk.concentrationRisk, risk.pathRisk, risk.executionRisk, risk.evidenceRisk, "|",
    n(m.medianHoldMinutes), n(m.averageLeverage, 2), n(m.oosSharpe, 2), n(m.crossWindowStability, 2), n(m.executionCoverage, 2), m.executionFit,
  );
}
console.log("\nmanifest", JSON.stringify({ status: run.review?.manifest?.status, reason: run.review?.manifest?.reason, sources: run.review?.manifest?.sources?.length }));
const summary=(run.review?.summary??[]) as {candidate:number;kind:string;metrics:Frame['candidates'][number]['metrics'];gate:{reasons:string[]}|null}[];
const compare=(overrides:Partial<Policy>)=>summary.filter(c=>{
  const r=rows.get(c.candidate);return r?.role&&r.risk&&candidateGate(c.metrics,r.role as Row,r.risk as Row,{...policy,...overrides}).reasons.length===0;
}).length;
const proposals:Partial<Policy>[]=[
  ...[85,90,95].map(riskRejectThreshold=>({riskRejectThreshold})),
  ...[35,30].map(minConfidence=>({minConfidence})),
  ...[40,30].map(minExecutionFit=>({minExecutionFit})),
  {riskRejectThreshold:85,minExecutionFit:40},
];
const passing=summary.filter(c=>c.gate?.reasons.length===0);
const oldGateSameRatings=summary.filter(c=>{
  const r=rows.get(c.candidate);return r?.role&&r.risk&&Number(r.risk.evidenceRisk)<policy.riskRejectThreshold&&
    candidateGate(c.metrics,r.role as Row,r.risk as Row,{...policy,minConfidence:60}).reasons.length===0;
}).length;
const blockers:Record<string,number>={};for(const c of summary)for(const reason of c.gate?.reasons??['no-model-output'])blockers[reason]=(blockers[reason]??0)+1;
const report={provider:values.provider,preparedOnly:values['prepare-only'],offline:values.offline,replayedStages,replayRunHash:replayHash??null,cacheMisses,stageFailures,agentTimeoutMs:timeoutMs,serial:values.serial,stageSpacingMs:spacingMs,requestedFinalists:finalists,riskRejectThreshold:policy.riskRejectThreshold,asOf:new Date(now).toISOString(),requestedModel:model,accounts:inputs.length,highFrequencyExcluded:highFrequency,scored:selectedInputs.length,finalists:summary.length,modelCalls,
  kinds:summary.reduce((n,c)=>(n[c.kind]=(n[c.kind]??0)+1,n),{} as Record<string,number>),
  candidatePass:passing.length,oldGateSameRatings,passingKinds:passing.reduce((n,c)=>(n[c.kind]=(n[c.kind]??0)+1,n),{} as Record<string,number>),
  blockers,outcome,freezeEligible:run.review?.freezeEligible??false,manifest:run.review?.manifest,
  proposalsNotApplied:proposals.map(overrides=>({overrides,candidatePass:compare(overrides),scope:'candidate checks only; not a portfolio approval'}))};
console.log('CHECK',JSON.stringify(report));
if(values.output)await Bun.write(values.output,JSON.stringify({report,run,...(values['prepare-only']?{preparedRequests}:{})},null,2));
await sql.close();

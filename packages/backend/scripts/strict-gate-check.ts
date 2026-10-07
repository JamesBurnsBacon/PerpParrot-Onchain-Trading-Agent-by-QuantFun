// Measures the AI review's strict gate on live data (docs/agents/STRICT_GATE_PLAN.md): leaderboard
// traders + hyperliquidvaults.com vaults → Score's 25 finalists → measured evidence → Role, Risk
// and Red-Team (real model calls) → the review core's verdict, with REVIEW_GATE=strict. Prints
// each finalist's model scores next to its measured evidence. Read-only on Hyperliquid; writes
// only to the local Postgres you give it (apply supabase/migrations first). Never trades.
//
//   OPENAI_API_KEY=… DATABASE_URL=postgres://…local… bun run scripts/strict-gate-check.ts \
//     [--traders 40] [--vaults 40] [--inputs cache.json] [--gate strict|basic]
//
// --inputs caches the fetched accounts (the slow part, ~5 min) so reruns only redo the review.
import { parseArgs } from "node:util";
import { SQL } from "bun";
import {localReviewDb} from './local-review-db';
import {candidateGate} from '../review/workflow';
import type {Frame,Row} from '../../shared/src/contracts.ts';
import { Pipeline, reviewPolicy } from "../src/pipeline";
import { fillStats, pickLeaderboard, type LeaderboardRow } from "../src/pipeline/derive";
import { pickVaults } from "../src/pipeline/vaults";
import { PacedInfo, getJson } from "../src/pipeline/hl";
import { parsePortfolio, scoreCandidates, type ScoreInput } from "../src/score";

const { values } = parseArgs({
  options: {
    traders: { type: "string", default: "40" },
    vaults: { type: "string", default: "40" },
    inputs: { type: "string" },
    gate: { type: "string", default: "strict" },
    "local-dir": {type:"string"},
    reads: {type:"string"},
    output: {type:"string"},
    "as-of": {type:"string"},
  },
});
const url=process.env.DATABASE_URL;
if(!values['local-dir']&&(!url||!['localhost','127.0.0.1','[::1]'].includes(new URL(url).hostname)))
  throw new Error('Use --local-dir or a loopback DATABASE_URL; remote databases are forbidden');
if(!process.env.OPENAI_API_KEY)throw new Error('OPENAI_API_KEY is required');
const sql=values['local-dir']?await localReviewDb(values['local-dir']):new SQL(url!);
// Reuse identical public reads for same-input model comparisons. Never cache keys or model calls.
const reads:Record<string,unknown>=values.reads&&await Bun.file(values.reads).exists()?await Bun.file(values.reads).json():{};
const modelCalls:{model:string;usage:unknown;elapsedMs:number}[]=[];
const realFetch=globalThis.fetch;
globalThis.fetch=(async(input:Parameters<typeof fetch>[0],init?:RequestInit)=>{
  const url=String(input instanceof Request?input.url:input);
  const publicRead=/^https:\/\/(api.hyperliquid.xyz|stats-data.hyperliquid.xyz|hyperliquidvaults.com)\//.test(url);
  const key=JSON.stringify([url,init?.body??'']);
  if(publicRead&&Object.hasOwn(reads,key))return Response.json(reads[key]);
  const started=performance.now(),response=await realFetch(input,init);
  if(url==='https://api.openai.com/v1/chat/completions'&&response.ok){
    const result=await response.clone().json() as {model:string;usage:unknown};
    modelCalls.push({model:result.model,usage:result.usage,elapsedMs:Math.round(performance.now()-started)});
  }
  if(publicRead&&response.ok&&response.headers.get('content-type')?.includes('json')){
    reads[key]=await response.clone().json();if(values.reads)await Bun.write(values.reads,JSON.stringify(reads));
  }
  return response;
}) as typeof fetch;
class ReadCachedInfo extends PacedInfo {
  override async post<T>(body:Record<string,unknown>,weight=20,items?:(value:T)=>number):Promise<T>{
    const key=JSON.stringify(['https://api.hyperliquid.xyz/info',JSON.stringify(body)]);
    if(Object.hasOwn(reads,key))return structuredClone(reads[key]) as T;
    return super.post(body,weight,items); // all cache misses remain rate limited
  }
}
const log = (m: string, d?: object) => console.log(new Date().toISOString().slice(11, 19), m, JSON.stringify(d ?? {}).slice(0, 300));
const now = values["as-of"] ? Date.parse(values["as-of"]) : Date.now();
if(!Number.isSafeInteger(now))throw new Error("invalid --as-of");
const cache = values.inputs ? Bun.file(values.inputs) : undefined;
let inputs: ScoreInput[] = cache && (await cache.exists()) ? await cache.json() : [];
if (inputs.length === 0) {
  const vaults = await pickVaults(now, log);
  const board = await getJson<{ leaderboardRows: LeaderboardRow[] }>("https://stats-data.hyperliquid.xyz/Mainnet/leaderboard");
  const traders = pickLeaderboard(board.leaderboardRows, Number(values.traders), new Set(vaults.map((v) => v.address)));
  const hl = new ReadCachedInfo(900);
  for (const t of [...traders, ...vaults.slice(0, Number(values.vaults))]) {
    try {
      const portfolio = await hl.post<unknown>({ type: "portfolio", user: t.address });
      const fills = await hl.post<Parameters<typeof fillStats>[0]>({ type: "userFillsByTime", user: t.address, startTime: now - 30 * 86_400_000, aggregateByTime: true }, 20, (f) => f.length);
      const { tradeCount, makerShare } = fillStats(fills, now);
      inputs.push({ address: t.address, kind: t.kind, accountValue: t.accountValue, closed: t.closed, ...parsePortfolio(portfolio), history: null, tradeCount, makerShare });
      if(inputs.length%10===0)log('fetched',{accounts:inputs.length});
    } catch (e) {
      log("skipped", { address: t.address, error: (e as Error).message });
    }
  }
  if (cache) await Bun.write(cache, JSON.stringify(inputs));
}
log("accounts", { count: inputs.length });

const result = scoreCandidates(inputs, { finalists: 25 });
const pipeline = new Pipeline({
  sql,
  now:()=>now,
  info:perMinute=>new ReadCachedInfo(perMinute),
  account: "0x7269502c48c582768ee38e4e71e7572e6ebf70f7",
  policy: reviewPolicy(await Bun.file(new URL("../fixtures/review-policy.json", import.meta.url)).json()),
  openAiKey: process.env.OPENAI_API_KEY,
  gate: values.gate === "basic" ? "basic" : "strict",
  log,
});
const [{ id }] = await sql`insert into selection_runs (started_at, status, accounts) values (now(), 'running', ${inputs.length}) returning id`;
// review() is the pipeline's selection step after Score (private; this script is its harness).
let outcome:unknown;
try {outcome=await (pipeline as unknown as { review: (...a: unknown[]) => Promise<unknown> }).review(Number(id), inputs, result, 0);}
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
const policy=reviewPolicy(await Bun.file(new URL('../fixtures/review-policy.json',import.meta.url)).json());
const compare=(threshold:number)=>summary.filter(c=>{
  const r=rows.get(c.candidate);return r?.role&&r.risk&&candidateGate(c.metrics,r.role as Row,r.risk as Row,{...policy,riskRejectThreshold:threshold}).reasons.length===0;
}).length;
const passing=summary.filter(c=>c.gate?.reasons.length===0);
const blockers:Record<string,number>={};for(const c of summary)for(const reason of c.gate?.reasons??['no-model-output'])blockers[reason]=(blockers[reason]??0)+1;
const report={asOf:new Date(now).toISOString(),accounts:inputs.length,finalists:summary.length,modelCalls,
  kinds:summary.reduce((n,c)=>(n[c.kind]=(n[c.kind]??0)+1,n),{} as Record<string,number>),
  candidatePass:passing.length,passingKinds:passing.reduce((n,c)=>(n[c.kind]=(n[c.kind]??0)+1,n),{} as Record<string,number>),
  blockers,outcome,freezeEligible:run.review?.freezeEligible??false,manifest:run.review?.manifest,
  proposalsNotApplied:[85,90,95].map(threshold=>({riskRejectThreshold:threshold,candidatePass:compare(threshold),scope:'candidate checks only; not a portfolio approval'}))};
console.log('CHECK',JSON.stringify(report));
if(values.output)await Bun.write(values.output,JSON.stringify({report,run},null,2));
await sql.close();

import {validate} from '../../shared/src/validate.ts';
import {validateManifest} from '../../shared/src/authorization.ts';
import {commitment,verifyInputCommitments} from '../../shared/src/commitments.ts';
import type {Binding, Frame, Policy, Row, Observation, Critique, Manifest, Source} from '../../shared/src/contracts.ts';

const ROLE = ['preserver','compounder','diversifier','directional','opportunistic','convexity','reject','conservativeFit','balancedFit','aggressiveFit','confidence'];
const RISK = ['drawdownRisk','leverageRisk','concentrationRisk','pathRisk','executionRisk','evidenceRisk','confidence'];
const DIMENSIONS = RISK.filter(k => k !== 'confidence').sort();
export interface Assessment {
  executableTargets: number;
  // Must include worst-case active-source renormalization and market eligibility.
  grossLeverage: number;
  withinPolicy: boolean;
}
export interface Dependencies {
  quorum: number;
  nodeIds: readonly string[];
  agentTimeoutMs: number;
  clock(): number;
  rolePromptHash: string; riskPromptHash: string; redTeamPromptHash: string; modelConfigHash: string;
  role(frame: Frame, signal: AbortSignal): Promise<Observation[]>;
  risk(frame: Frame, signal: AbortSignal): Promise<Observation[]>;
  redTeam(input: {frame: Frame; policy: Policy; draftHash: string; sources: Omit<Source,'sourceAddress'>[]; cashWeight: number}, signal: AbortSignal): Promise<Critique[]>;
  assess(sources: readonly Source[], frame: Frame, policy: Policy): Assessment;
}
function ensure(ok: boolean, message: string): asserts ok { if (!ok) throw new Error(message); }
function median(values: number[], integer = true, roundUp = true): number {
  const sorted = [...values].sort((a,b) => a-b), mid = Math.floor(sorted.length/2);
  const value = sorted.length % 2 ? sorted[mid] : (sorted[mid-1] + sorted[mid])/2;
  return integer ? (roundUp ? Math.ceil(value) : Math.floor(value)) : value;
}
function ids(rows: {candidate:number}[], expected: number[]) {
  ensure(rows.length === expected.length && new Set(rows.map(r=>r.candidate)).size === expected.length && rows.every(r=>expected.includes(r.candidate)), 'candidate mismatch');
}
function binding(observation: Binding & {promptHash:string; modelConfigHash:string}, frame: Frame, prompt: string, deps: Dependencies) {
  ensure(observation.schemaVersion === frame.schemaVersion && observation.snapshotHash === frame.snapshotHash && observation.policyHash === frame.policyHash && observation.promptHash === prompt && observation.modelConfigHash === deps.modelConfigHash, 'observation binding mismatch');
}
function aggregate(observations: Observation[], frame: Frame, deps: Dependencies, kind: 'role'|'risk'): Row[] {
  authenticatedNodes(observations,deps);
  const expected = frame.candidates.map(c=>c.candidate).sort((a,b)=>a-b);
  for (const observation of observations) {
    binding(observation, frame, kind === 'role' ? deps.rolePromptHash : deps.riskPromptHash, deps);
    const {nodeId,...payload} = observation;
    validate(`${kind}-consensus`, {...payload, quorum: deps.quorum});
    ids(observation.results, expected);
  }
  const fields = kind === 'role' ? ROLE : RISK;
  return expected.map(candidate => Object.fromEntries([['candidate',candidate], ...fields.map(field=>[field,median(observations.map(o=>o.results.find(r=>r.candidate===candidate)![field]),true,kind==='role' ? field==='reject' : field!=='confidence')])]) as Row);
}
export function riskDecision(row: Row, policy: Policy) {
  const bindingConstraint = [...DIMENSIONS].sort((a,b)=>row[b]-row[a] || (a < b ? -1 : a > b ? 1 : 0))[0];
  const severity = row[bindingConstraint];
  const status = severity >= policy.riskRejectThreshold ? 'REJECT' : severity >= policy.riskWatchThreshold ? 'WATCHLIST' : 'CAP';
  return {status, bindingConstraint, ceiling: status === 'REJECT' ? 0 : policy.maxSourceWeight * (1-severity/100)};
}
/** The compiler's mandatory candidate gates, also exposed for faithful rejection diagnostics. */
export function candidateCompileFailures(candidate:Frame['candidates'][number],policy:Policy,role:Row|undefined,risk:Row|undefined):string[] {
  const m=candidate.metrics;
  const checks:[string,boolean][]=[
    ['HISTORY_TOO_SHORT',m.historyDays<policy.minHistoryDays],['NO_OOS_WINDOWS',m.oosWindows<1],
    ['OOS_SHARPE_UNKNOWN',m.oosSharpe===null],['OOS_SORTINO_UNKNOWN',m.oosSortino===null],
    ['OOS_DRAWDOWN_UNKNOWN',m.oosMaxDrawdown===null],['WINDOW_STABILITY_UNKNOWN',m.crossWindowStability===null],
    ['AVERAGE_LEVERAGE_UNKNOWN',m.averageLeverage===null],['HOLDING_PERIOD_UNKNOWN',m.medianHoldMinutes===null],
    ['HOLDING_BELOW_ONE_HOUR',m.medianHoldMinutes!==null&&m.medianHoldMinutes<60],
    ['EXECUTION_FIT_UNKNOWN',m.executionFit===null],['EXECUTION_FIT_BELOW_POLICY',m.executionFit!==null&&m.executionFit<policy.minExecutionFit],
    ['EXECUTION_COVERAGE_UNKNOWN',m.executionCoverage===null],['NO_EXECUTION_COVERAGE',m.executionCoverage!==null&&m.executionCoverage<=0],
    ['ROLE_OBSERVATION_MISSING',role===undefined],['RISK_OBSERVATION_MISSING',risk===undefined],
    ['ROLE_CONFIDENCE_BELOW_POLICY',role!==undefined&&role.confidence<policy.minConfidence],
    ['RISK_CONFIDENCE_BELOW_POLICY',risk!==undefined&&risk.confidence<policy.minConfidence],
    ['ROLE_REJECTED',role!==undefined&&role.reject>=policy.riskRejectThreshold],
    ['RISK_REJECTED',risk!==undefined&&riskDecision(risk,policy).status==='REJECT'],
  ];
  return checks.filter(([,failed])=>failed).map(([reason])=>reason);
}
function compile(frame: Frame, policy: Policy, role: Row[], risk: Row[], addresses: ReadonlyMap<number,string>): Source[] {
  const fitKey = `${policy.bucket.toLowerCase()}Fit`;
  const ranked = frame.candidates.flatMap(c => {
    const r = role.find(r=>r.candidate===c.candidate)!, k = risk.find(r=>r.candidate===c.candidate)!;
    const m = c.metrics, decision = riskDecision(k, policy);
    if (candidateCompileFailures(c,policy,r,k).length) return [];
    // Stronger latency penalty for 1–3h and softer for 3–6h; replay-calibrate.
    const latency = m.medianHoldMinutes! < 180 ? 0.5 : m.medianHoldMinutes! < 360 ? 0.75 : 1;
    const score = r[fitKey] * latency;
    if (score <= 0) return [];
    return [{candidate:c.candidate, score, ceiling:decision.ceiling}];
  }).sort((a,b)=>b.score-a.score || a.candidate-b.candidate);
  const selected: typeof ranked = [];
  for (const c of ranked) {
    const compatible = selected.every(other => {
      const pair = frame.pairs.find(p=>(p.a===c.candidate && p.b===other.candidate)||(p.b===c.candidate && p.a===other.candidate));
      // Unknown (null) correlation or overlap is never compatible: missing evidence is not safety.
      return pair && pair.correlation!==null && Math.abs(pair.correlation)<=policy.maxPairCorrelation && pair.currentExposureOverlap!==null && pair.currentExposureOverlap<=policy.maxExposureOverlap && !pair.linkedSource;
    });
    if (compatible) selected.push(c);
  }
  const total = selected.reduce((sum,c)=>sum+c.score,0);
  return selected.map(c=>({candidate:c.candidate,sourceAddress:addresses.get(c.candidate)!,weight:Math.min((1-policy.cashBuffer)*c.score/total,c.ceiling),maxAllocation:c.ceiling}));
}
/** Offline review orchestration. No signing, exchange calls, freeze mutation or mirror inference. */
export async function runReview(inputFrame: Frame, inputPolicy: Policy, inputAddresses: ReadonlyMap<number,string>, nowMs: number, dependencies: Dependencies): Promise<Manifest> {
  // Own the input snapshot before the first await; caller mutations cannot change authorization.
  const frame = structuredClone(inputFrame), policy = structuredClone(inputPolicy), addresses = new Map(inputAddresses);
  const deps = {...dependencies,nodeIds:[...dependencies.nodeIds]};
  validate('candidate-curation-frame',frame); validate('bucket-policy',policy);
  ensure(Number.isSafeInteger(nowMs) && nowMs>=0, 'invalid clock');
  ensure(Number.isInteger(deps.quorum) && deps.quorum>0 && deps.quorum<=deps.nodeIds.length && deps.nodeIds.length<=100 && new Set(deps.nodeIds).size===deps.nodeIds.length && deps.nodeIds.every(id=>typeof id==='string' && id.length>0), 'invalid configured quorum/membership');
  ensure(Number.isSafeInteger(deps.agentTimeoutMs) && deps.agentTimeoutMs>0 && deps.agentTimeoutMs<=60000,'invalid agent deadline');
  ensure(policy.riskWatchThreshold<=policy.riskRejectThreshold && policy.minConfidence>0 && policy.riskRejectThreshold>0 && policy.redTeamRebuildThreshold>0 && policy.redTeamExcludeThreshold>0, 'invalid thresholds');
  ensure(policy.mode!=='LIVE' || policy.bucket==='AGGRESSIVE', 'only Aggressive can be live');
  const expected = frame.candidates.map(c=>c.candidate);
  ensure(new Set(expected).size===expected.length && addresses.size===expected.length && expected.every(id=>/^0x[0-9a-f]{40}$/.test(addresses.get(id) ?? '')) && new Set(addresses.values()).size===expected.length, 'invalid source mapping');
  const pairKeys = frame.pairs.map(p=>[p.a,p.b].sort((a,b)=>a-b).join(':'));
  ensure(new Set(pairKeys).size===pairKeys.length && frame.pairs.every(p=>p.a!==p.b && expected.includes(p.a) && expected.includes(p.b)), 'invalid pairs');
  ensure(verifyInputCommitments(frame,policy,addresses), 'unverified input commitment');
  let previousTime = nowMs;
  const currentTime = () => {
    const time = deps.clock();
    ensure(Number.isSafeInteger(time) && time>=previousTime,'invalid/nonmonotonic clock');
    previousTime=time; return time;
  };
  const fresh = () => {const time=currentTime();return frame.asOfMs<=time && time<frame.expiresAtMs && time-frame.asOfMs<=policy.maxFrameAgeMs;};
  const finish = (status: Manifest['status'], reason: Manifest['reason'], sources: Source[]=[], rebuildCount: 0|1=0): Manifest => {
    const createdAtMs=currentTime();
    if (status==='VALID' && (createdAtMs<frame.asOfMs || createdAtMs>=frame.expiresAtMs || createdAtMs-frame.asOfMs>policy.maxFrameAgeMs)) {
      status='INVALID_BUCKET';reason='STALE_INPUT';sources=[];
    }
    const payload = {...frameBinding(frame),createdAtMs,expiresAtMs:frame.expiresAtMs,bucket:policy.bucket,mode:policy.mode,status,rebuildCount,policy,sources,cashWeight:1-sources.reduce((sum,s)=>sum+s.weight,0),reason};
    const manifest = {...payload,manifestHash:commitment('perpparrot:manifest:v1',payload)};
    validate('bucket-manifest',manifest);validateManifest(manifest,createdAtMs);return manifest;
  };
  if (!fresh()) return finish('INVALID_BUCKET','STALE_INPUT');
  let role: Row[], risk: Row[];
  try {
    const observations = await deadline(deps.agentTimeoutMs,signal=>Promise.all([deps.role(structuredClone(frame),signal),deps.risk(structuredClone(frame),signal)]));
    role = aggregate(observations[0],frame,deps,'role'); risk = aggregate(observations[1],frame,deps,'risk');
  } catch { return finish('INVALID_BUCKET','AGENT_FAILURE'); }
  if (!fresh()) return finish('INVALID_BUCKET','STALE_INPUT');
  let sources = compile(frame,policy,role,risk,addresses);
  if (!sources.length || sources.every(s=>s.weight<=0)) return finish('INVALID_BUCKET','INSUFFICIENT_EVIDENCE');
  const draft = {sources:sources.map(({sourceAddress,...row})=>row),cashWeight:1-sources.reduce((sum,s)=>sum+s.weight,0)};
  const draftHash = commitment('perpparrot:draft:v1',{...frameBinding(frame),policy,...draft});
  let penalties: Map<number,number>, rebuild: boolean;
  try {
    const observations = await deadline(deps.agentTimeoutMs,signal=>deps.redTeam({frame:structuredClone(frame),policy:structuredClone(policy),draftHash,...draft},signal));
    authenticatedNodes(observations,deps);
    const selected = sources.map(s=>s.candidate);
    for (const o of observations) {
      binding(o,frame,deps.redTeamPromptHash,deps); ensure(o.draftHash===draftHash,'wrong draft');
      const {nodeId,...payload}=o;
      validate('redteam-consensus',{...payload,quorum:deps.quorum}); ids(o.penalties,selected);
    }
    penalties = new Map(selected.map(id=> {
      const rows = observations.map(o=>o.penalties.find(p=>p.candidate===id)!);
      return [id,median(rows.map(r=>r.excludeScore))>=policy.redTeamExcludeThreshold ? 0 : median(rows.map(r=>r.multiplier),false)];
    }));
    rebuild = Math.max(median(observations.map(o=>o.rebuildScore)),median(observations.map(o=>o.portfolioRisk)))>=policy.redTeamRebuildThreshold || [...penalties.values()].some(p=>p<1);
  } catch { return finish('INVALID_BUCKET','AGENT_FAILURE'); }
  if (!fresh()) return finish('INVALID_BUCKET','STALE_INPUT');
  if (rebuild && ![...penalties.values()].some(p=>p<1)) return finish('INVALID_BUCKET','POLICY_VIOLATION');
  if (rebuild) {
    // Recompile the original draft once: exact penalties, no redistribution or new sources.
    sources = sources.flatMap(source => {
      const multiplier = penalties.get(source.candidate)!;
      return multiplier === 0 ? [] : [{...source,weight:source.weight*multiplier,maxAllocation:source.maxAllocation*multiplier}];
    });
  }
  const count = rebuild ? 1 : 0;
  if (!sources.length) return finish('INVALID_BUCKET','POLICY_VIOLATION',[],count);
  const sum = sources.reduce((total,s)=>total+s.weight,0);
  if (sum>1-policy.cashBuffer+1e-9 || sources.some(s=>s.weight<=0 || s.weight>s.maxAllocation+1e-9 || s.maxAllocation>policy.maxSourceWeight+1e-9)) return finish('INVALID_BUCKET','POLICY_VIOLATION',[],count);
  let assessment: Assessment;
  try { assessment = deps.assess(structuredClone(sources),structuredClone(frame),structuredClone(policy)); }
  catch { return finish('INVALID_BUCKET','POLICY_VIOLATION',[],count); }
  if (assessment.withinPolicy!==true || !Number.isFinite(assessment.grossLeverage) || assessment.grossLeverage<0 || assessment.grossLeverage>policy.maxGrossLeverage) return finish('INVALID_BUCKET','POLICY_VIOLATION',[],count);
  if (!Number.isInteger(assessment.executableTargets) || assessment.executableTargets<policy.minExecutableTargets || assessment.executableTargets>10) return finish('INVALID_BUCKET','CAPACITY',[],count);
  if (!fresh()) return finish('INVALID_BUCKET','STALE_INPUT',[],count);
  return finish('VALID','OK',sources,count);
}
function frameBinding(frame: Frame): Binding { return {schemaVersion:frame.schemaVersion,snapshotHash:frame.snapshotHash,policyHash:frame.policyHash}; }

function authenticatedNodes(observations: {nodeId:string}[], deps: Dependencies) {
  ensure(observations.length>=deps.quorum && observations.length<=deps.nodeIds.length,'insufficient/oversized quorum');
  const nodes=observations.map(o=>o.nodeId);
  ensure(new Set(nodes).size===nodes.length && nodes.every(id=>deps.nodeIds.includes(id)),'duplicate/unknown node');
}
async function deadline<T>(timeoutMs: number, action: (signal:AbortSignal)=>Promise<T>): Promise<T> {
  const controller=new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const timeout=new Promise<never>((_,reject)=>{timer=setTimeout(()=>{controller.abort();reject(new Error('agent deadline exceeded'));},timeoutMs);});
    return await Promise.race([Promise.resolve().then(()=>action(controller.signal)),timeout]);
  } finally {if(timer!==undefined)clearTimeout(timer);controller.abort();}
}

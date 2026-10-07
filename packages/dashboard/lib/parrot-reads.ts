// Read-only Dashboard facts for the parrot's three extra tools (run status, wallet drill-down, backtest).
// Public GETs only: no executor mutation, no secrets. Code builds every number the parrot may say; an
// unavailable source is reported as unavailable, never filled in.
import type { BacktestArtifact, FunnelArtifact } from "../../shared/dashboard";
import type { DryRunPlan } from "../../shared/dry-run-plan";
import type { WalletEvidence } from "../../shared/wallet-evidence";
import { walletNickname } from "../../shared/wallet-persona";
import { BACKEND, EXECUTOR, ordersOf, runTime, type Exposures, type PipelineView, type Run, type Series, type Status } from "./data";

import { isReadTool, type ConfirmToolName, type ReadToolName } from "./parrot-read-tools";
export { isReadTool, READ_TOOL_NAMES, type ReadToolName } from "./parrot-read-tools";

export type WalletLine = { label: string; value: string };
export type LiveCard =
  | { kind: "run"; runs: Run[]; status: Status | null; exposures: { asset: string; fraction: number }[]; asOf: number }
  | { kind: "wallet"; address: string; nickname: string; lines: WalletLine[]; rationale: string | null; picked: boolean | null; asOf: number }
  | { kind: "backtest"; window: string; series: Series[]; generatedAt: number }
  | { kind: "request"; stage: "awaiting" | "saved"; plan: DryRunPlan; previewHash: string; requestId: string | null; sources: number }
  | { kind: "unavailable"; tool: ReadToolName | ConfirmToolName; what: string };
export type ReadResult = { facts: string; card: LiveCard };

const FACTS_MAX = 1200; // the same cap the strategy facts keep (shared with the receipts judge)
const cap = (text: string) => (text.length <= FACTS_MAX ? text : `${text.slice(0, FACTS_MAX - 1)}…`);
const utc = (ms: number) => `${new Date(ms).toISOString().slice(11, 16)}Z`;
const signed = (v: number, digits = 1) => `${v >= 0 ? "+" : ""}${v.toFixed(digits)}`;
const pctText = (v: number, digits = 1) => `${signed(v, digits)}%`;
const fraction = (v: number | null | undefined) => (v == null || !Number.isFinite(v) ? "unavailable" : `${Number((v * 100).toFixed(2))}%`);
const shortAddress = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;

// An unavailable backtest (not published yet, or unreadable; the source does not tell them apart) is not worth a screen:
// the facts still go to the parrot, which says so in one line, and the page stays as it was.
export const showsCard = (card: LiveCard): boolean => !(card.kind === "unavailable" && card.tool === "get_backtest");
const unavailable = (tool: ReadToolName, what: string, facts: string): ReadResult => ({ facts: cap(facts), card: { kind: "unavailable", tool, what } });

// ---- get_run_status -------------------------------------------------------------------------------------------
export type RunInputs = { runs: Run[] | null; status: Status | null; exposures: Exposures | null };

export function buildRunStatus({ runs, status, exposures }: RunInputs, now = Date.now()): ReadResult {
  const mirror = (runs ?? []).filter(r => r.kind === "mirror");
  if (!status && !mirror.length) {
    return unavailable("get_run_status", "No run data yet", "Run status: not available right now (the executor returned nothing). Say you cannot see it; never guess.");
  }
  const parts: string[] = [];
  if (status) parts.push(`${status.dryRun ? "Dry run: no real orders are sent" : "Live trading"}${status.controls.paused ? ", currently paused" : ""}`);
  const last = mirror[0];
  if (last) {
    parts.push(`last run ${utc(runTime(last))}: ${last.status.replace("_", " ")}, ${ordersOf(last)} orders${last.error ? ", with an error" : ""}`);
    const counts = (s: Run["status"]) => mirror.filter(r => r.status === s).length;
    parts.push(`of the last ${mirror.length} runs: ${counts("executed")} executed, ${counts("failed")} failed, ${counts("skipped_paused")} skipped while paused`);
    if (last.equityUsd !== undefined) parts.push(`account equity $${last.equityUsd.toFixed(2)}`);
    if (last.evidence) parts.push(`each run records the hash of the positions snapshot it traded toward (latest ${last.evidence.snapshotHash.slice(0, 10)}…)`);
  } else parts.push(runs === null ? "the run history could not be read just now" : "no run is recorded yet");
  const top = (exposures?.exposures ?? []).slice().sort((a, b) => Math.abs(b.fraction) - Math.abs(a.fraction)).slice(0, 3);
  if (top.length) parts.push(`latest target exposures: ${top.map(e => `${e.asset} ${fraction(e.fraction)}`).join(", ")}`);
  return {
    facts: cap(`Run status: ${parts.join("; ")}.`),
    card: { kind: "run", runs: mirror, status, exposures: exposures?.exposures ?? [], asOf: now },
  };
}

// ---- explain_wallet -------------------------------------------------------------------------------------------
// A wallet is named by its shortlist position ("3", "rank 3"), its bird nickname, or an address prefix.
// Every candidate is returned: callers act only on a unique match, so a shared prefix never explains the wrong wallet.
export function findWallets(ref: string, shown: string[], known: string[] = []): string[] {
  const r = ref.trim().toLowerCase().replace(/^#/, "");
  if (!r) return [];
  const position = /^(?:rank\s*|number\s*|no\.?\s*)?(\d{1,2})$/.exec(r);
  if (position) { const hit = shown[Number(position[1]) - 1]; return hit ? [hit] : []; }
  const exact = shown.filter(a => walletNickname(a).toLowerCase() === r);
  if (exact.length) return exact;
  const byName = r.length >= 3 ? shown.filter(a => walletNickname(a).toLowerCase().includes(r)) : [];
  if (byName.length) return byName;
  if (/^(0x)?[0-9a-f]{4,40}$/.test(r)) {
    const prefix = r.startsWith("0x") ? r : `0x${r}`;
    return [...new Set([...shown, ...known].filter(a => a.toLowerCase().startsWith(prefix)))];
  }
  return [];
}
export const resolveWallet = (ref: string, shown: string[], known: string[] = []): string | null => {
  const hits = findWallets(ref, shown, known);
  return hits.length === 1 ? hits[0] : null;
};

export type WalletInputs = { ref: string; shown: string[]; evidence: WalletEvidence[]; funnel: FunnelArtifact | null; pipeline: PipelineView | null };

export function buildWallet({ ref, shown, evidence, funnel, pipeline }: WalletInputs, now = Date.now()): ReadResult {
  const finalists = funnel?.finalists ?? [];
  const hits = findWallets(ref, shown, finalists.map(f => f.address));
  if (hits.length !== 1) {
    // Model-supplied text is never echoed into the facts.
    return unavailable("explain_wallet", hits.length ? "Which wallet?" : "Wallet not found", hits.length
      ? "Wallet drill-down: more than one wallet matches that reference. Ask the visitor for the list position."
      : "Wallet drill-down: that reference does not match a wallet on the current list. Ask the visitor for the list position or the bird name.");
  }
  const address = hits[0];
  const nickname = walletNickname(address);
  const e = evidence.find(x => x.address.toLowerCase() === address.toLowerCase());
  const f = finalists.find(x => x.address.toLowerCase() === address.toLowerCase());
  const key = address.toLowerCase();
  const summary = pipeline?.latest?.summary?.find(s => s.address?.toLowerCase() === key);
  const bench = pipeline?.latest?.bench?.find(b => b.address.toLowerCase() === key);
  const overlap = pipeline?.latest?.finalists?.overlap?.byAddress?.[address] ?? pipeline?.latest?.finalists?.overlap?.byAddress?.[key];
  const lines: WalletLine[] = [];
  if (e) {
    lines.push({ label: "Score rank", value: `#${e.rank}` }, { label: "Max drawdown", value: fraction(e.maxDrawdown) }, { label: "Realized volatility", value: fraction(e.realizedVol) });
    if (e.periodReturn != null) lines.push({ label: "Period return", value: fraction(e.periodReturn) });
    if (e.sharpe != null) lines.push({ label: "Sharpe", value: String(e.sharpe) });
  }
  if (f) lines.push({ label: "Pipeline score", value: f.score.toFixed(2) }, { label: "Picked by the pipeline", value: f.picked ? "yes" : "no" });
  if (summary?.leverageRisk != null) lines.push({ label: "Leverage risk", value: `${Math.round(summary.leverageRisk)} of 100` });
  if (summary?.evidenceRisk != null) lines.push({ label: "Evidence risk", value: `${Math.round(summary.evidenceRisk)} of 100` });
  if (bench?.copyableShare != null) lines.push({ label: "Copyable share", value: fraction(bench.copyableShare) });
  if (overlap !== undefined) lines.push({ label: "Position overlap with other picks", value: fraction(overlap) });
  const rationale = f?.rationale?.trim() ? f.rationale.trim().slice(0, 320) : null;
  const header = `Wallet drill-down for ${nickname} (${shortAddress(address)})`;
  if (!lines.length && !rationale && (funnel === null || pipeline === null)) {
    return unavailable("explain_wallet", "Could not check the sources", `${header}: the Dashboard sources could not be read just now, so I cannot say. Do not guess.`);
  }
  if (!lines.length && !rationale) {
    return {
      facts: cap(`${header}: the Dashboard has no record of this wallet (it may be a sample or not in the latest pipeline run). Say so; never guess.`),
      card: { kind: "wallet", address, nickname, lines: [], rationale: null, picked: null, asOf: now },
    };
  }
  const body = lines.map(l => `${l.label} ${l.value}`).join("; ");
  return {
    facts: cap(`${header}: ${body}${rationale ? `. Review note: ${rationale}` : ""}. These are past measurements, not a promise of returns.`),
    card: { kind: "wallet", address, nickname, lines, rationale, picked: f ? f.picked : null, asOf: now },
  };
}

// ---- get_backtest ---------------------------------------------------------------------------------------------
const shortLabel = (label: string, all: string[]) => {
  const first = (l: string) => l.split(" ")[0];
  return all.filter(l => first(l) === first(label)).length > 1 ? label : first(label);
};

export function buildBacktest(artifact: BacktestArtifact | null): ReadResult {
  if (!artifact?.series?.length) {
    return unavailable("get_backtest", "Backtest not available", "Backtest: not available right now (not published yet, or it could not be read). Say so; never guess.");
  }
  const labels = artifact.series.map(s => s.label);
  const series: Series[] = artifact.series.map((s, i) => ({
    id: s.id, label: s.label, short: shortLabel(s.label, labels), reference: s.id === "btc",
    color: s.id === "btc" ? "var(--muted)" : `var(--series-${(i % 4) + 1})`,
    points: s.points.map(([t, v]) => [t, (v - 1) * 100] as [number, number]),
  }));
  const end = (id: string) => series.find(s => s.id === id)?.points.at(-1)?.[1];
  const btc = end("btc");
  const rows = series.filter(s => s.id !== "btc" && s.points.length).map(s => {
    const v = s.points.at(-1)![1];
    return `${s.label} ${pctText(v)}${btc !== undefined ? ` (${signed(v - btc)} points vs BTC)` : ""}`;
  });
  return {
    facts: cap(`Backtest over ${artifact.window}, out of sample: ${btc !== undefined ? `holding BTC ${pctText(btc)}; ` : ""}${rows.join("; ") || "no strategy line"}. A backtest is history, not a promise of returns.`),
    card: { kind: "backtest", window: artifact.window, series, generatedAt: artifact.generatedAt },
  };
}

// ---- response guards (a malformed 200 is treated like a failed fetch) ------------------------------------------
const rec = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
const num = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const isStatus = (v: unknown): v is Status => rec(v) && typeof v.dryRun === "boolean" && rec(v.controls) && typeof v.controls.paused === "boolean";
const RUN_STATES = ["executed", "skipped_paused", "failed"];
const isRuns = (v: unknown): v is Run[] => Array.isArray(v) && v.every(r => rec(r) && typeof r.runId === "string" && (r.kind === "mirror" || r.kind === "flatten") && RUN_STATES.includes(r.status as string) && num(r.startedAt) && typeof r.dryRun === "boolean");
const isExposures = (v: unknown): v is Exposures => rec(v) && Array.isArray(v.exposures) && v.exposures.every(e => rec(e) && typeof e.asset === "string" && num(e.fraction));
const isBacktest = (v: unknown): v is BacktestArtifact => rec(v) && num(v.generatedAt) && typeof v.window === "string" && Array.isArray(v.series) &&
  v.series.every(s => rec(s) && typeof s.id === "string" && typeof s.label === "string" && Array.isArray(s.points) && s.points.every(p => Array.isArray(p) && p.length === 2 && num(p[0]) && num(p[1])));
const isFunnel = (v: unknown): v is FunnelArtifact => rec(v) && (v.finalists === undefined || (Array.isArray(v.finalists) && v.finalists.every(f => rec(f) && typeof f.address === "string" && num(f.score) && typeof f.picked === "boolean")));
const isPipeline = (v: unknown): v is PipelineView => rec(v);

// ---- fetching (same origin, public GETs, short deadline) -----------------------------------------------------------
async function getJson<T>(base: string, path: string, signal: AbortSignal, guard: (v: unknown) => v is T): Promise<T | null> {
  try {
    const url = new URL(`${base.replace(/\/$/, "")}${path}`, window.location.origin);
    if (url.origin !== window.location.origin || url.username || url.password) return null;
    const res = await fetch(url, { method: "GET", credentials: "omit", cache: "no-store", redirect: "error", signal });
    if (!res.ok) return null;
    const body: unknown = await res.json();
    return guard(body) ? body : null;
  } catch { return null; }
}

export type ReadContext = { shown: string[]; evidence: WalletEvidence[] };
// Never throws: a malformed endpoint response becomes an "unavailable" card instead of ending the voice call.
export async function runReadTool(name: ReadToolName, args: Record<string, unknown>, ctx: ReadContext, signal: AbortSignal): Promise<ReadResult> {
  try { return await readTool(name, args, ctx, signal); }
  catch { return unavailable(name, "Could not read that data", "The Dashboard data could not be read just now. Say you cannot see it; never guess."); }
}

async function readTool(name: ReadToolName, args: Record<string, unknown>, ctx: ReadContext, signal: AbortSignal): Promise<ReadResult> {
  const deadline = AbortSignal.any([signal, AbortSignal.timeout(8_000)]);
  if (name === "get_run_status") {
    const [runs, status, exposures] = await Promise.all([
      getJson(EXECUTOR, "/runs?limit=8", deadline, isRuns), getJson(EXECUTOR, "/status", deadline, isStatus), getJson(BACKEND, "/exposures", deadline, isExposures),
    ]);
    return buildRunStatus({ runs, status, exposures });
  }
  if (name === "get_backtest") return buildBacktest(await getJson(BACKEND, "/artifacts/backtest", deadline, isBacktest));
  const ref = typeof args.wallet === "string" ? args.wallet.slice(0, 64) : "";
  const [funnel, pipeline] = await Promise.all([
    getJson(BACKEND, "/artifacts/funnel", deadline, isFunnel), getJson(BACKEND, "/pipeline", deadline, isPipeline),
  ]);
  return buildWallet({ ref, shown: ctx.shown, evidence: ctx.evidence, funnel, pipeline });
}

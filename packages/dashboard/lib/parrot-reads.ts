// Read-only Dashboard facts for the parrot's three extra tools (run status, wallet drill-down, backtest).
// Public GETs only: no executor mutation, no secrets. Code builds every number the parrot may say; an
// unavailable source is reported as unavailable, never filled in.
import type { BacktestArtifact, FunnelArtifact } from "../../shared/dashboard";
import type { WalletEvidence } from "../../shared/wallet-evidence";
import { walletNickname } from "../../shared/wallet-persona";
import { BACKEND, EXECUTOR, ordersOf, runTime, type Exposures, type PipelineView, type Run, type Series, type Status } from "./data";

import { isReadTool, type ReadToolName } from "./parrot-read-tools";
export { isReadTool, READ_TOOL_NAMES, type ReadToolName } from "./parrot-read-tools";

export type WalletLine = { label: string; value: string };
export type LiveCard =
  | { kind: "run"; runs: Run[]; status: Status | null; exposures: { asset: string; fraction: number }[]; asOf: number }
  | { kind: "wallet"; address: string; nickname: string; lines: WalletLine[]; rationale: string | null; picked: boolean | null; asOf: number }
  | { kind: "backtest"; window: string; series: Series[]; generatedAt: number }
  | { kind: "unavailable"; tool: ReadToolName; what: string };
export type ReadResult = { facts: string; card: LiveCard };

const FACTS_MAX = 1200; // the same cap the strategy facts keep (shared with the receipts judge)
const cap = (text: string) => (text.length <= FACTS_MAX ? text : `${text.slice(0, FACTS_MAX - 1)}…`);
const utc = (ms: number) => `${new Date(ms).toISOString().slice(11, 16)}Z`;
const signed = (v: number, digits = 1) => `${v >= 0 ? "+" : ""}${v.toFixed(digits)}`;
const pctText = (v: number, digits = 1) => `${signed(v, digits)}%`;
const fraction = (v: number | null | undefined) => (v == null || !Number.isFinite(v) ? "unavailable" : `${Number((v * 100).toFixed(2))}%`);
const shortAddress = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;

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
  } else parts.push("no run is recorded yet");
  const top = (exposures?.exposures ?? []).slice().sort((a, b) => Math.abs(b.fraction) - Math.abs(a.fraction)).slice(0, 3);
  if (top.length) parts.push(`latest target exposures: ${top.map(e => `${e.asset} ${fraction(e.fraction)}`).join(", ")}`);
  return {
    facts: cap(`Run status: ${parts.join("; ")}.`),
    card: { kind: "run", runs: mirror, status, exposures: exposures?.exposures ?? [], asOf: now },
  };
}

// ---- explain_wallet -------------------------------------------------------------------------------------------
// A wallet is named by its shortlist position ("3", "rank 3"), its bird nickname, or an address prefix.
export function resolveWallet(ref: string, shown: string[], known: string[] = []): string | null {
  const r = ref.trim().toLowerCase().replace(/^#/, "");
  if (!r) return null;
  const position = /^(?:rank\s*|number\s*|no\.?\s*)?(\d{1,2})$/.exec(r);
  if (position) return shown[Number(position[1]) - 1] ?? null;
  const byName = shown.find(a => walletNickname(a).toLowerCase() === r) ?? (r.length >= 3 ? shown.find(a => walletNickname(a).toLowerCase().includes(r)) : undefined);
  if (byName) return byName;
  if (/^(0x)?[0-9a-f]{4,40}$/.test(r)) {
    const prefix = r.startsWith("0x") ? r : `0x${r}`;
    return [...shown, ...known].find(a => a.toLowerCase().startsWith(prefix)) ?? null;
  }
  return null;
}

export type WalletInputs = { ref: string; shown: string[]; evidence: WalletEvidence[]; funnel: FunnelArtifact | null; pipeline: PipelineView | null };

export function buildWallet({ ref, shown, evidence, funnel, pipeline }: WalletInputs, now = Date.now()): ReadResult {
  const finalists = funnel?.finalists ?? [];
  const address = resolveWallet(ref, shown, finalists.map(f => f.address));
  if (!address) {
    return unavailable("explain_wallet", "Wallet not found", `Wallet drill-down: I could not match "${ref.slice(0, 40)}" to a wallet on the current list. Ask the visitor for the list position or the bird name.`);
  }
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
  if (summary?.leverageRisk != null) lines.push({ label: "Leverage risk", value: summary.leverageRisk.toFixed(2) });
  if (summary?.evidenceRisk != null) lines.push({ label: "Evidence risk", value: summary.evidenceRisk.toFixed(2) });
  if (bench?.copyableShare != null) lines.push({ label: "Copyable share", value: fraction(bench.copyableShare) });
  if (overlap !== undefined) lines.push({ label: "Position overlap with other picks", value: fraction(overlap) });
  const rationale = f?.rationale?.trim() ? f.rationale.trim().slice(0, 320) : null;
  const header = `Wallet drill-down for ${nickname} (${shortAddress(address)})`;
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
    return unavailable("get_backtest", "Backtest not published yet", "Backtest: not published yet, so there is nothing to compare. Say so; never guess.");
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

// ---- fetching (same origin, public GETs, short deadline) -----------------------------------------------------------
async function getJson<T>(base: string, path: string, signal: AbortSignal): Promise<T | null> {
  try {
    const url = new URL(`${base.replace(/\/$/, "")}${path}`, window.location.origin);
    if (url.origin !== window.location.origin || url.username || url.password) return null;
    const res = await fetch(url, { method: "GET", credentials: "omit", cache: "no-store", redirect: "error", signal });
    return res.ok ? ((await res.json()) as T) : null;
  } catch { return null; }
}

export type ReadContext = { shown: string[]; evidence: WalletEvidence[] };
export async function runReadTool(name: ReadToolName, args: Record<string, unknown>, ctx: ReadContext, signal: AbortSignal): Promise<ReadResult> {
  const deadline = AbortSignal.any([signal, AbortSignal.timeout(8_000)]);
  if (name === "get_run_status") {
    const [runs, status, exposures] = await Promise.all([
      getJson<Run[]>(EXECUTOR, "/runs?limit=8", deadline), getJson<Status>(EXECUTOR, "/status", deadline), getJson<Exposures>(BACKEND, "/exposures", deadline),
    ]);
    return buildRunStatus({ runs, status, exposures });
  }
  if (name === "get_backtest") return buildBacktest(await getJson<BacktestArtifact>(BACKEND, "/artifacts/backtest", deadline));
  const ref = typeof args.wallet === "string" ? args.wallet : "";
  const [funnel, pipeline] = await Promise.all([
    getJson<FunnelArtifact>(BACKEND, "/artifacts/funnel", deadline), getJson<PipelineView>(BACKEND, "/pipeline", deadline),
  ]);
  return buildWallet({ ref, shown: ctx.shown, evidence: ctx.evidence, funnel, pipeline });
}

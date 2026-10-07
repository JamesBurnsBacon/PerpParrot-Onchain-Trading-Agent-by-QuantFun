"use client";
import { useEffect, useState } from "react";
import type { BacktestArtifact, FunnelArtifact } from "../../shared/dashboard";

// Same origin by default: vercel.json routes these paths to the backend and executor
// services (and next.config.ts proxies them to the local servers under `next dev`).
export const BACKEND = process.env.NEXT_PUBLIC_BACKEND_URL ?? "/api/backend";
export const EXECUTOR = process.env.NEXT_PUBLIC_EXECUTOR_URL ?? "/api/executor";

export type PaperView = {
  lastRunAt: number | null;
  books: {
    id: string;
    label: string;
    kind: "copy" | "btc";
    startingEquityUsd: number;
    equityUsd: number;
    returnPct: number;
    feesUsd: number;
    fundingUsd?: number; // net paid; negative = received
    trades: number;
    openPositions: number;
    curve: [number, number][];
  }[];
};

export type Run = {
  id: string;
  runId: string;
  kind: "mirror" | "flatten";
  status: "executed" | "skipped_paused" | "failed";
  dryRun: boolean;
  startedAt: number;
  finishedAt: number;
  equityUsd?: number;
  error?: string;
  orders?: number; // summaries only
  plan?: {
    orders: { asset: string; isBuy: boolean; notionalUsd: number; targetUsd: number; currentUsd: number }[];
    skipped: { asset: string; reason: string; targetUsd: number; currentUsd: number }[];
    marginScale?: number;
  };
  results?: { status: string }[];
  // What the run traded toward (full records only).
  evidence?: { snapshotHash: string; configurationHash: string; exposures: { asset: string; exposureE9: string }[] };
};

export const ordersOf = (r: Run) => r.orders ?? r.plan?.orders.length ?? 0;

export type Equity = { runs: number; points: [tMs: number, equityUsd: number][] };
export type Status = { dryRun: boolean; account: string; controls: { paused: boolean }; lastRunAt: number | null };
export type Exposures = { runAt: number; exposures: { asset: string; fraction: number }[] };

// Backend GET /pipeline (src/pipeline status()); timestamps are ISO strings.
export type SelectionStatus = "running" | "activated" | "kept" | "benched" | "rejected" | "failed";

// The per-wallet roster (docs/ingest/ROSTER.md); times in ms.
export type SeatState = "probation" | "seated" | "winding_down" | "released" | "removed";
export type RosterSeat = {
  address: string;
  state: SeatState;
  weightUnits: number;
  fit: number | null;
  turnoverPerDay: number | null;
  tradedPerDayOverEquity: number | null;
  admittedAt: number;
  minTenureUntil: number;
  flatSince: number | null;
  flatRuns: number;
  windDownUntil: number | null;
  caps: Record<string, number> | null;
};
export type RosterEvent = { at: string; address: string; kind: "seeded" | "admitted" | "seated" | "released" | "removed" | "winding_down" | "weight"; detail: Record<string, unknown> | null };
export type RosterView = { seats: RosterSeat[]; events: RosterEvent[]; impliedTurnover: number | null };
export type BenchRow = { address: string; fit: number; approvedAt: number; copyableShare: number | null; closedPositions: number; turnoverPerDay: number | null; passesHold: boolean };
export type PipelineView = {
  // Hyperliquid read routing of the serving backend instance (absent on older backends).
  routing?: {
    mode: string;
    official: { requests: number; errors: number; totalMs: number };
    nownodes: { requests: number; errors: number; totalMs: number };
    fallbacks: number;
    shadow: { compared: number; mismatches: number };
    breakerOpen: boolean;
  };
  accounts: { listed: number; fresh: number; errors: number; listed_at: string | null; qualified?: number; high_frequency?: number; qualified_at?: string | null };
  selections: {
    id: number;
    started_at: string;
    finished_at: string | null;
    status: SelectionStatus;
    accounts: number | null;
    configuration_hash: string | null;
    error: string | null;
    manifest: { status: string; reason: string; sources: { address: string; weight: number }[] } | null;
  }[];
  active: { hash: string; activated_at: string; sources: { candidate: number; sourceAddress: string; weightUnits: number; ceilingUnits: number }[] } | null;
  // The latest run only (absent on older backends).
  latest?: {
    id: number;
    finalists: {
      finalists: { address: string; kind?: string; score?: number; rank?: number }[];
      funnel: { stage: string; count: number }[];
      // Same-direction position overlap among the picks (absent on older runs).
      overlap?: { threshold: number; pairs: number; above: number; max: number; top: { a: string; b: string; overlap: number }[]; byAddress: Record<string, number> };
      // Present only when the overlap guard picked this run (PICK_OVERLAP_GUARD=on).
      overlapGuard?: { pool: number; reads: number; failed: number; excluded: number; toppedUp: number; threshold: number; ms: number; provider: { nownodes: number; official: number; fallbacks: number } };
    } | null;
    summary: { candidate: number; address?: string; aggressiveFit: number | null; reject: number | null; leverageRisk: number | null; evidenceRisk: number | null }[] | null;
    // The wallets this review approved for the roster, with their hold measures (absent before the roster).
    bench?: BenchRow[] | null;
  } | null;
  // The per-wallet roster (absent before its migration).
  roster?: RosterView | null;
};

export type DashboardData = {
  paper: PaperView | null;
  runs: Run[] | null; // summaries of the last day's runs
  equity: Equity | null; // the live account at every executed run since the start
  recent: Run[] | null; // full records with plans and evidence, newest first
  status: Status | null;
  exposures: Exposures | null;
  backtest: BacktestArtifact | null;
  funnel: FunnelArtifact | null;
  pipeline: PipelineView | null;
  loadedAt: number;
};

const get = async <T,>(url: string): Promise<T | null> => {
  try {
    const res = await fetch(url, { cache: "no-store" });
    return res.ok ? ((await res.json()) as T) : null;
  } catch {
    return null;
  }
};

export const load = async (): Promise<DashboardData> => {
  const [paper, runs, equity, recent, status, exposures, backtest, funnel, pipeline] = await Promise.all([
    get<PaperView>(`${BACKEND}/paper`),
    get<Run[]>(`${EXECUTOR}/runs?summary=1&limit=144`),
    get<Equity>(`${EXECUTOR}/equity`),
    get<Run[]>(`${EXECUTOR}/runs?limit=8`),
    get<Status>(`${EXECUTOR}/status`),
    get<Exposures>(`${BACKEND}/exposures`),
    get<BacktestArtifact>(`${BACKEND}/artifacts/backtest`),
    get<FunnelArtifact>(`${BACKEND}/artifacts/funnel`),
    get<PipelineView>(`${BACKEND}/pipeline`),
  ]);
  return { paper, runs, equity, recent, status, exposures, backtest, funnel, pipeline, loadedAt: Date.now() };
};

// Refreshes every minute: mirror runs land every 10 min, so this is plenty live.
export const useDashboard = (): DashboardData | null => {
  const [data, setData] = useState<DashboardData | null>(null);
  useEffect(() => {
    let alive = true;
    const tick = () => load().then((d) => alive && setData(d));
    tick();
    const id = setInterval(tick, 60_000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, []);
  return data;
};

export type Series = {
  id: string;
  label: string;
  short: string; // direct label at the line end
  color: string;
  reference?: boolean; // benchmark: dashed, muted
  points: [tMs: number, value: number][];
};

// % return against `base` (default: the first point); nothing without a positive base.
const toReturns = (points: [number, number][], base = points[0]?.[1]): [number, number][] =>
  base !== undefined && base > 0 ? points.map(([t, v]) => [t, (v / base - 1) * 100]) : [];

// A run's scheduled time (runId "mirror-<runAt>"), the same clock as the paper books.
export const runTime = (r: Run) => {
  const m = /-(\d+)$/.exec(r.runId);
  return m ? Number(m[1]) * 1000 : r.startedAt;
};

// Live account (from its first executed run) and paper books (from their starting capital), as % return.
export const performanceSeries = (paper: PaperView | null, equity: Equity | null): Series[] => {
  const series: Series[] = [];
  const live = equity?.points ?? [];
  if (live.length) series.push({ id: "live", label: "Live account", short: "Live", color: "var(--series-1)", points: toReturns(live) });

  const slots: Record<string, [color: string, short: string]> = {
    "aggressive-470": ["var(--series-2)", "$470"],
    "aggressive-10k": ["var(--series-3)", "$10k"],
    "balanced-470": ["var(--series-4)", "Balanced"],
  };
  for (const b of paper?.books ?? []) {
    // Paper books start from their capital, so the first fills' fees show.
    const points = toReturns(b.curve.map(([t, v]) => [t * 1000, v]), b.startingEquityUsd);
    if (!points.length) continue;
    if (b.kind === "btc") series.push({ id: b.id, label: "BTC buy & hold", short: "BTC", color: "var(--muted)", reference: true, points });
    else if (slots[b.id]) series.push({ id: b.id, label: b.label.replace(" · ", " "), short: slots[b.id][1], color: slots[b.id][0], points });
  }
  return series;
};

export const pct = (v: number, digits = 2) => `${v >= 0 ? "+" : ""}${v.toFixed(digits)}%`;
export const usd = (v: number) =>
  v.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: v >= 1000 ? 0 : 2 });
export const time = (ms: number) => new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
export const dayTime = (ms: number) =>
  new Date(ms).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });

// Time labels for a chart: clock time within a day and a half, date and time beyond.
export const stamp = (series: Series[]) => {
  const ts = series.flatMap((s) => s.points.map((p) => p[0]));
  let lo = Infinity;
  let hi = -Infinity;
  for (const t of ts) {
    if (t < lo) lo = t;
    if (t > hi) hi = t;
  }
  return hi - lo > 36 * 3600e3 ? dayTime : time;
};

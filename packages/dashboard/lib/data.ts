"use client";
import { useEffect, useState } from "react";

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
    startedAt?: number; // the run that created the book (unix seconds; absent on older backends)
    equityUsd: number;
    returnPct: number;
    feesUsd: number;
    fundingUsd?: number; // net paid; negative = received
    trades: number;
    // Traded notional per day ÷ starting capital (absent on older backends; null until tracked).
    turnoverPerDay?: number | null;
    tradedSince?: number | null;
    multiplier?: number;
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
export type Exposures = {
  runAt: number;
  exposures: { asset: string; fraction: number }[];
  sources?: { address: string; weight: number; contributions: { asset: string; fraction: number }[] }[];
};

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
  // 30-day average leverage: the seat is copied at 2× ÷ this (absent before the normalization).
  averageLeverage?: number | null;
};
export type RosterEvent = { at: string; address: string; kind: "seeded" | "admitted" | "seated" | "released" | "removed" | "winding_down" | "weight"; detail: Record<string, unknown> | null };
export type RosterView = { seats: RosterSeat[]; events: RosterEvent[]; impliedTurnover: number | null };
export type BenchRow = { address: string; fit: number; approvedAt: number; copyableShare: number | null; closedPositions: number; turnoverPerDay: number | null; passesHold: boolean };
export type PipelineView = {
  // NOWNodes cross-check of each mirror snapshot (SNAPSHOT_VERIFY; absent on older backends, mode "off" when unset).
  verification?: {
    mode: "off" | "on" | "strict";
    checks: number;
    verified: number;
    mismatches: number;
    unverified: number;
    last: { verdict: "verified" | "mismatch" | "unverified"; sources: number; retried: number; ms: number; at: number; diffs: { address: string; asset: string }[]; unverified: string[] } | null;
  };
  // Hyperliquid read routing of the serving backend instance (absent on older backends).
  routing?: {
    mode: string;
    official: { requests: number; errors: number; totalMs: number };
    nownodes: { requests: number; errors: number; totalMs: number };
    fallbacks: number;
    shadow: { compared: number; mismatches: number };
    breakerOpen: boolean;
    // The last NOWNodes capability probe (absent or null when the probe is off).
    capabilities?: {
      probedAt: number;
      rows: { method: string; status: number | null; verdict: "supported" | "unsupported" | "inconclusive"; allowlisted: boolean; drift: boolean; ms: number }[];
      narrowed: string[];
      newlySupported: string[];
    } | null;
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
    gate?: "strict" | "basic" | "none" | null;
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
      // Which picks are contracts on HyperEVM, via NOWNodes' /evm (CONTRACT_CHECK=on; evidence only, absent otherwise).
      contracts?: { provider: "nownodes"; checked: number; contracts: { address: string; bytes: number }[]; unread: string[]; ms: number };
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
  const [paper, runs, equity, recent, status, exposures, pipeline] = await Promise.all([
    get<PaperView>(`${BACKEND}/paper`),
    get<Run[]>(`${EXECUTOR}/runs?summary=1&limit=144`),
    get<Equity>(`${EXECUTOR}/equity`),
    get<Run[]>(`${EXECUTOR}/runs?limit=8`),
    get<Status>(`${EXECUTOR}/status`),
    get<Exposures>(`${BACKEND}/exposures`),
    get<PipelineView>(`${BACKEND}/pipeline`),
  ]);
  return { paper, runs, equity, recent, status, exposures, pipeline, loadedAt: Date.now() };
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
  bookId?: string; // the paper book behind the line, if any
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

// The three buckets, shown at the live size only (the backend's $10k twins stay unshown).
// Aggressive is the live bucket: the account's own curve once it trades for real (not dry run),
// until then its $470 paper model. Balanced and Conservative are modeled: paper books.
export const BUCKETS = [
  { id: "aggressive", book: "aggressive-470", label: "Aggressive", short: "Aggressive", color: "var(--aggressive)" },
  { id: "balanced", book: "balanced-470", label: "Balanced ×0.5", short: "Balanced", color: "var(--balanced)" },
  { id: "conservative", book: "conservative-470", label: "Conservative ×0.25", short: "Conservative", color: "var(--conservative)" },
] as const;

// Whether the Aggressive line is the live account itself (else its paper model).
// Live once the newest executed run traded for real and the account has live equity points. Read from
// the runs, not /status: the dashboard's executor (Vercel) stays in dry run while the long-running one
// (Railway) trades.
export const liveIsReal = (recent: Run[] | null, equity: Equity | null) =>
  recent?.find((r) => r.kind === "mirror" && r.status === "executed")?.dryRun === false && (equity?.points.length ?? 0) > 0;

// The live account's row for the table under the chart (the paper books come from /paper, the live account does not):
// its latest equity, and how many positions the last executed live run traded toward (null when that run has no record).
export const liveBookRow = (equity: Equity | null, recent: Run[] | null): { equityUsd: number; positions: number | null } | null => {
  const equityUsd = equity?.points.at(-1)?.[1];
  if (equityUsd === undefined) return null;
  const run = recent?.find((r) => r.kind === "mirror" && r.status === "executed" && r.dryRun === false);
  const targets = run?.evidence?.exposures;
  return { equityUsd, positions: targets ? targets.filter((e) => !/^-?0+$/.test(e.exposureE9)).length : null };
};

// Each bucket and BTC as % return: the live account from its first executed run, paper books from their starting capital.
export const performanceSeries = (paper: PaperView | null, equity: Equity | null, recent: Run[] | null): Series[] => {
  const series: Series[] = [];
  const book = (id: string) => paper?.books.find((b) => b.id === id);
  // Paper books start from their capital, so the first fills' fees show. A curve that begins at its
  // book's first run gets a 0% origin a minute before it: capital set, no orders yet.
  const bookReturns = (b: PaperView["books"][number]) => {
    const points = toReturns(b.curve.map(([t, v]) => [t * 1000, v]), b.startingEquityUsd);
    return b.startedAt !== undefined && b.curve[0]?.[0] === b.startedAt ? [[b.startedAt * 1000 - 60_000, 0] as [number, number], ...points] : points;
  };
  for (const k of BUCKETS) {
    const b = k.id === "aggressive" && liveIsReal(recent, equity) ? undefined : book(k.book);
    const points = b ? bookReturns(b) : k.id === "aggressive" ? toReturns(equity?.points ?? []) : [];
    if (points.length) series.push({ id: k.id, bookId: b?.id, label: k.label, short: k.short, color: k.color, points });
  }
  const btc = paper?.books.find((b) => b.kind === "btc");
  const points = btc ? bookReturns(btc) : [];
  if (btc && points.length) series.push({ id: "btc", bookId: btc.id, label: "BTC", short: "BTC", color: "var(--muted)", reference: true, points });
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

"use client";
import { useEffect, useState } from "react";
import type { BacktestArtifact, FunnelArtifact } from "../../shared/dashboard";

export const BACKEND = process.env.NEXT_PUBLIC_BACKEND_URL ?? "http://localhost:8788";
export const EXECUTOR = process.env.NEXT_PUBLIC_EXECUTOR_URL ?? "http://localhost:8787";

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
    trades: number;
    openPositions: number;
    curve: [number, number][];
  }[];
};

export type Run = {
  id: string;
  runId: string;
  kind: "report" | "flatten";
  status: "executed" | "skipped_paused" | "failed";
  dryRun: boolean;
  startedAt: number;
  finishedAt: number;
  equityUsd?: number;
  error?: string;
  orders?: number; // summaries only
  plan?: { orders: { asset: string; isBuy: boolean; notionalUsd: number }[]; skipped: unknown[] };
  results?: { status: string }[];
  envelope?: { report: string; context: string; signatures: string[] };
};

export const ordersOf = (r: Run) => r.orders ?? r.plan?.orders.length ?? 0;

export type Status = { dryRun: boolean; account: string; controls: { paused: boolean }; lastReportAt: number | null };
export type Exposures = { runAt: number; exposures: { asset: string; fraction: number }[] };

export type DashboardData = {
  paper: PaperView | null;
  runs: Run[] | null; // summaries, ~30 days
  recent: Run[] | null; // full records with signed reports, newest first
  status: Status | null;
  exposures: Exposures | null;
  backtest: BacktestArtifact | null;
  funnel: FunnelArtifact | null;
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
  const [paper, runs, recent, status, exposures, backtest, funnel] = await Promise.all([
    get<PaperView>(`${BACKEND}/paper`),
    get<Run[]>(`${EXECUTOR}/runs?summary=1&limit=4320`),
    get<Run[]>(`${EXECUTOR}/runs?limit=8`),
    get<Status>(`${EXECUTOR}/status`),
    get<Exposures>(`${BACKEND}/exposures`),
    get<BacktestArtifact>(`${BACKEND}/artifacts/backtest`),
    get<FunnelArtifact>(`${BACKEND}/artifacts/funnel`),
  ]);
  return { paper, runs, recent, status, exposures, backtest, funnel, loadedAt: Date.now() };
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

// % return against `base` (default: the first point).
const toReturns = (points: [number, number][], base = points[0]?.[1]): [number, number][] =>
  base ? points.map(([t, v]) => [t, (v / base - 1) * 100]) : [];

// A run's scheduled time (runId "mirror-<runAt>"), the same clock as the paper books.
export const runTime = (r: Run) => {
  const m = /-(\d+)$/.exec(r.runId);
  return m ? Number(m[1]) * 1000 : r.startedAt;
};

// Live account (executor runs) and paper books as % return since their first point.
export const performanceSeries = (paper: PaperView | null, runs: Run[] | null): Series[] => {
  const series: Series[] = [];
  const live = (runs ?? [])
    .filter((r) => r.kind === "report" && r.status === "executed" && typeof r.equityUsd === "number")
    .map((r) => [runTime(r), r.equityUsd!] as [number, number])
    .sort((a, b) => a[0] - b[0]);
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
const dayTime = (ms: number) =>
  new Date(ms).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });

// Time labels for a chart: clock time within a day and a half, date and time beyond.
export const stamp = (series: Series[]) => {
  const ts = series.flatMap((s) => s.points.map((p) => p[0]));
  return Math.max(...ts) - Math.min(...ts) > 36 * 3600e3 ? dayTime : time;
};

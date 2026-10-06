import { computeMetrics } from "../score/metrics";
import { rankByMetrics } from "../score/score";
import type { Metrics, TimePoint } from "../score/types";

export type PortfolioWindow = { accountValueHistory: TimePoint[]; pnlHistory: TimePoint[] };
export type BacktestSource = { address: string; month: PortfolioWindow };
export type SourceResult = { address: string; rank: number; selected: boolean; trainMetrics: Metrics; testReturn: number };
export type BacktestResult = {
  asOfMs: number;
  cutoffMs: number;
  requestedWindowMs: number;
  sourceCount: number;
  selectedCount: number;
  selectedMedianReturn: number;
  cohortMedianReturn: number;
  selectedOutperformanceBps: number;
  sources: SourceResult[];
  limitations: string[];
};

const DAY = 86_400_000;
const median = (values: number[]): number => {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};

function valid(window: PortfolioWindow): void {
  const { accountValueHistory: equity, pnlHistory: pnl } = window;
  if (!Array.isArray(equity) || !Array.isArray(pnl) || equity.length !== pnl.length || equity.length < 12) {
    throw new Error("each source needs at least 12 aligned monthly portfolio observations");
  }
  for (let i = 0; i < equity.length; i++) {
    if (!Number.isSafeInteger(equity[i][0]) || !Number.isFinite(equity[i][1]) || equity[i][1] <= 0 ||
      !Number.isSafeInteger(pnl[i][0]) || pnl[i][0] !== equity[i][0] || !Number.isFinite(pnl[i][1]) ||
      (i > 0 && equity[i][0] <= equity[i - 1][0])) throw new Error("invalid or unaligned portfolio history");
  }
}

function windowFrom(points: TimePoint[], pnl: TimePoint[]): PortfolioWindow {
  return { accountValueHistory: points, pnlHistory: pnl };
}

function compoundReturn(source: BacktestSource, after: number, through: number): number {
  const { accountValueHistory: equity, pnlHistory: pnl } = source.month;
  let result = 1;
  let intervals = 0;
  for (let i = 1; i < equity.length; i++) {
    const [ts] = equity[i];
    // Do not attribute a sparse interval that straddles the cutoff to the holdout.
    if (equity[i - 1][0] < after || ts > through) continue;
    const startEquity = equity[i - 1][1];
    const deltaPnl = pnl[i][1] - pnl[i - 1][1];
    const r = deltaPnl / startEquity;
    if (!Number.isFinite(r) || r <= -1) throw new Error(`invalid test return for ${source.address}`);
    result *= 1 + r;
    intervals++;
  }
  if (intervals < 3) throw new Error(`insufficient held-out observations for ${source.address}`);
  return result - 1;
}

/**
 * Evaluate the existing rank formula using only observations before a shared cutoff.
 * The result is a cross-sectional source-ranking diagnostic, not a copied portfolio simulation.
 */
export function runPointInTimeBacktest(
  input: BacktestSource[],
  options: { cutoffMs: number; asOfMs: number; finalists?: number; minTrainIntervals?: number } ,
): BacktestResult {
  const { cutoffMs, asOfMs } = options;
  const finalists = options.finalists ?? 5;
  const minTrainIntervals = options.minTrainIntervals ?? 8;
  if (!Number.isSafeInteger(cutoffMs) || !Number.isSafeInteger(asOfMs) || cutoffMs >= asOfMs || finalists < 1) {
    throw new Error("invalid backtest bounds");
  }
  const addresses = new Set<string>();
  for (const source of input) {
    if (!/^0x[0-9a-f]{40}$/i.test(source.address) || addresses.has(source.address.toLowerCase())) throw new Error("invalid or duplicate source address");
    addresses.add(source.address.toLowerCase());
    valid(source.month);
    if (source.month.accountValueHistory.at(-1)![0] < asOfMs - 2 * DAY) throw new Error(`stale portfolio history: ${source.address}`);
  }
  if (input.length < finalists + 2) throw new Error("cohort is too small for a meaningful rank comparison");

  const train = input.map((source) => {
    const indices = source.month.accountValueHistory.map(([ts], i) => ts <= cutoffMs ? i : -1).filter((i) => i >= 0);
    if (indices.length < minTrainIntervals + 1) throw new Error(`insufficient training observations for ${source.address}`);
    const last = indices.at(-1)! + 1;
    const history = windowFrom(source.month.accountValueHistory.slice(0, last), source.month.pnlHistory.slice(0, last));
    const metrics = computeMetrics(history);
    if (metrics.flags.includes("no-intervals") || metrics.sortino === null && metrics.calmar === null && metrics.pnlConsistency === null) {
      throw new Error(`unrankable training history for ${source.address}`);
    }
    return { address: source.address, metrics };
  });
  const ranked = rankByMetrics(train, finalists);
  const sourceByAddress = new Map(input.map((source) => [source.address.toLowerCase(), source]));
  const results = ranked.map((row) => ({
    address: row.address,
    rank: row.rank,
    selected: row.finalist,
    trainMetrics: row.metrics,
    testReturn: compoundReturn(sourceByAddress.get(row.address.toLowerCase())!, cutoffMs, asOfMs),
  }));
  const selected = results.filter((row) => row.selected).map((row) => row.testReturn);
  const all = results.map((row) => row.testReturn);
  const selectedMedianReturn = median(selected);
  const cohortMedianReturn = median(all);
  return {
    asOfMs,
    cutoffMs,
    requestedWindowMs: asOfMs - cutoffMs,
    sourceCount: input.length,
    selectedCount: selected.length,
    selectedMedianReturn,
    cohortMedianReturn,
    selectedOutperformanceBps: (selectedMedianReturn - cohortMedianReturn) * 10_000,
    sources: results,
    limitations: [
      "Current-leaderboard cohort has survivorship and universe-selection bias; it is not a point-in-time universe.",
      "Hyperliquid portfolio graphs are sampled account-value/PnL data, not an accounting ledger; deposits, withdrawals, and sampling gaps can distort returns.",
      "This is a per-source ranking diagnostic. It does not simulate delayed fills, netting, fees, funding, slippage, minimum orders, capacity, or liquidation constraints.",
      "The current monthly history is a short single holdout. It cannot establish predictive edge or justify live allocation.",
    ],
  };
}

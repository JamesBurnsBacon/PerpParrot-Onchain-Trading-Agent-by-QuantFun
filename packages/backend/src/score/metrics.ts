import { usedIntervals } from "./returns";
import type { Metrics, WindowHistory } from "./types";

const finiteOrNull = (value: number): number | null => Number.isFinite(value) ? value : null;

// Non-annualised return metrics and UTC-day PnL consistency (README §4.2).
export const computeMetrics = (w: WindowHistory): Metrics => {
  const { intervals, flags } = usedIntervals(w);
  const time = intervals.reduce((sum, interval) => sum + interval.dt, 0);
  if (intervals.length === 0 || time === 0) {
    flags.push("no-intervals");
    return { sortino: null, calmar: null, maxDrawdown: null, pnlConsistency: null, realizedVol: null, flags };
  }

  const totalReturn = intervals.reduce((sum, { r }) => sum + r, 0);
  const downside = Math.sqrt(intervals.reduce((sum, { r }) => sum + Math.min(r, 0) ** 2, 0) / time);
  if (downside === 0) flags.push("no-downside");

  let curve = 1;
  let peak = 1;
  let maxDrawdown = 0;
  let ruined = false;
  const dailyPnl = new Map<number, number>();
  for (const { r, pnl, day } of intervals) {
    if (1 + r <= 0 && !ruined) {
      ruined = true;
      flags.push("ruin");
    }
    curve = ruined ? 0 : curve * (1 + r);
    peak = Math.max(peak, curve);
    maxDrawdown = Math.max(maxDrawdown, (peak - curve) / peak);
    dailyPnl.set(day, (dailyPnl.get(day) ?? 0) + pnl);
  }
  if (maxDrawdown === 0) flags.push("no-drawdown");
  const positiveDays = [...dailyPnl.values()].filter((pnl) => pnl > 0).length;

  return {
    sortino: downside === 0 ? null : finiteOrNull((totalReturn / time) / downside),
    calmar: maxDrawdown === 0 ? null : finiteOrNull((curve - 1) / maxDrawdown),
    maxDrawdown: finiteOrNull(maxDrawdown),
    pnlConsistency: finiteOrNull(positiveDays / dailyPnl.size),
    realizedVol: finiteOrNull(Math.sqrt(intervals.reduce((sum, { r }) => sum + r ** 2, 0) / time)),
    flags,
  };
};

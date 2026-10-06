// Pure per-account features for the maker-share study: maker share from fills, and flow-adjusted performance from
// `portfolio` windows (same return definition as the score, README §4.2).
import { computeIntervals, type Interval } from "../../../packages/backend/src/score/returns";
import type { TimePoint, WindowHistory } from "../../../packages/backend/src/score/types";

export const DAY_MS = 86_400_000;
const DUST_EQUITY_FRACTION = 0.01; // score DEFAULT_CONFIG

export type Fill = {
  coin: string;
  px: string;
  sz: string;
  crossed: boolean;
  fee: string;
  closedPnl: string;
  time: number;
};

// Spot coins are "@123" or "PURR/USDC"; everything else (validator perps, HIP-3 "dex:COIN") is a perp.
export const isPerp = (coin: string): boolean => !coin.startsWith("@") && !coin.includes("/");

export type MakerStats = {
  fills: number;
  volume: number;
  makerShare: number | null; // maker notional / total notional
  makerShareByCount: number | null;
  feeRate: number | null; // Σ fee / Σ notional; negative = net rebates
};

export const makerStats = (fills: Fill[]): MakerStats => {
  const perps = fills.filter((f) => isPerp(f.coin));
  let volume = 0;
  let makerVolume = 0;
  let makerCount = 0;
  let fees = 0;
  for (const f of perps) {
    const notional = Math.abs(Number(f.px) * Number(f.sz));
    volume += notional;
    fees += Number(f.fee);
    if (!f.crossed) {
      makerVolume += notional;
      makerCount++;
    }
  }
  return {
    fills: perps.length,
    volume,
    makerShare: volume > 0 ? makerVolume / volume : null,
    makerShareByCount: perps.length ? makerCount / perps.length : null,
    feeRate: volume > 0 ? fees / volume : null,
  };
};

// Points of one window between `from` and `to` (inclusive), joined on timestamps present in both histories.
export const windowPoints = (w: WindowHistory, from: number, to: number) => {
  const pnl = new Map(w.pnlHistory.map(([ts, v]) => [ts, v]));
  return w.accountValueHistory
    .filter(([ts]) => ts >= from && ts <= to && pnl.has(ts))
    .map(([ts, accountValue]: TimePoint) => ({ ts, accountValue, pnl: pnl.get(ts)! }));
};

export type Performance = {
  totalReturn: number;
  sharpe: number | null; // annualised, from daily returns on a log-interpolated equity curve
  maxDrawdown: number;
  days: number;
};

const equityCurve = (intervals: Interval[]): { ts: number; equity: number }[] => {
  const curve = [{ ts: intervals[0].start, equity: 1 }];
  for (const i of intervals) curve.push({ ts: i.end, equity: curve[curve.length - 1].equity * (1 + i.r) });
  return curve;
};

const logEquityAt = (curve: { ts: number; equity: number }[], ts: number): number => {
  let k = 1;
  while (k < curve.length - 1 && curve[k].ts < ts) k++;
  const a = curve[k - 1];
  const b = curve[k];
  const la = Math.log(Math.max(a.equity, 1e-9));
  const lb = Math.log(Math.max(b.equity, 1e-9));
  return b.ts === a.ts ? lb : la + ((lb - la) * (ts - a.ts)) / (b.ts - a.ts);
};

export const performance = (points: { ts: number; accountValue: number; pnl: number }[]): Performance | null => {
  if (points.length < 2) return null;
  const { intervals } = computeIntervals(points, DUST_EQUITY_FRACTION);
  const curve = equityCurve(intervals);
  let peak = 1;
  let maxDrawdown = 0;
  for (const { equity } of curve) {
    peak = Math.max(peak, equity);
    maxDrawdown = Math.max(maxDrawdown, 1 - equity / peak);
  }
  const first = curve[0].ts;
  const last = curve[curve.length - 1].ts;
  const daily: number[] = [];
  for (let t = first + DAY_MS; t <= last; t += DAY_MS) daily.push(logEquityAt(curve, t) - logEquityAt(curve, t - DAY_MS));
  const mean = daily.reduce((s, x) => s + x, 0) / daily.length;
  const sd = Math.sqrt(daily.reduce((s, x) => s + (x - mean) ** 2, 0) / (daily.length - 1));
  return {
    totalReturn: curve[curve.length - 1].equity - 1,
    sharpe: daily.length >= 5 && sd > 0 ? (mean / sd) * Math.sqrt(365) : null,
    maxDrawdown,
    days: (last - first) / DAY_MS,
  };
};

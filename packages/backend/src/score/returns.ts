import { DAY_MS } from "./stitch";

type Point = { ts: number; accountValue: number; pnl: number; fine?: boolean };

export type Interval = { start: number; end: number; dt: number; r: number; fine: boolean; used: boolean };

// Flows are backed out of PnL; deposits count as capital for the whole interval and dust intervals are
// skipped (SPEC "Returns").
export const computeIntervals = (
  points: Point[],
  dustEquityFraction: number,
): { intervals: Interval[]; flags: string[] } => {
  const peak = points.reduce((max, { accountValue }) => Math.max(max, accountValue), -Infinity);
  const intervals: Interval[] = [];
  const flags: string[] = [];
  for (let i = 1; i < points.length; i++) {
    const previous = points[i - 1];
    const current = points[i];
    const dpnl = current.pnl - previous.pnl;
    const flow = (current.accountValue - previous.accountValue) - dpnl;
    const capital = previous.accountValue + Math.max(flow, 0);
    const used = capital > 0 && capital >= dustEquityFraction * peak;
    if (!used) flags.push("dust-equity");
    intervals.push({
      start: previous.ts,
      end: current.ts,
      dt: (current.ts - previous.ts) / DAY_MS,
      r: used ? dpnl / capital : 0,
      fine: previous.fine !== false && current.fine !== false,
      used,
    });
  }
  return { intervals, flags };
};

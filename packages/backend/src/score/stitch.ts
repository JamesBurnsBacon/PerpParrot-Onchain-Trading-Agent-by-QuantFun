import type { ScoreConfig, ScoreInput, WindowHistory } from "./types";

export const DAY_MS = 86_400_000;

export type SeriesPoint = { ts: number; accountValue: number; pnl: number; fine: boolean };
export type Series = { points: SeriesPoint[]; flags: string[] };

// Matching, strictly increasing timestamps are required for scoring (SPEC "Series validation").
export const validateSeries = (w: WindowHistory | null): w is WindowHistory => {
  if (w === null || w.accountValueHistory.length < 2 || w.accountValueHistory.length !== w.pnlHistory.length) {
    return false;
  }
  return w.accountValueHistory.every(([timestamp], i) =>
    timestamp === w.pnlHistory[i][0] && (i === 0 || timestamp > w.accountValueHistory[i - 1][0]),
  );
};

// First allTime point with money in the account; null without a valid allTime (SPEC "Window").
export const activeStart = (allTime: WindowHistory | null): number | null => {
  if (!validateSeries(allTime)) return null;
  const first = allTime.accountValueHistory.find(([, value]) => value > 0);
  return first === undefined ? null : first[0];
};

type Point = { ts: number; accountValue: number; pnl: number };

const toPoints = (w: WindowHistory, offset = 0): Point[] =>
  w.accountValueHistory.map(([ts, accountValue], i) => ({ ts, accountValue, pnl: w.pnlHistory[i][1] + offset }));

// USD tolerance for the same point reported by two windows (SPEC "Alignment checks").
const close = (actual: number, reference: number): boolean =>
  Math.abs(actual - reference) <= 0.01 + 1e-9 * Math.abs(reference);

const agree = (points: Point[], reference: Point[]): boolean => {
  const byTs = new Map(reference.map((point) => [point.ts, point]));
  return points.every((point) => {
    const other = byTs.get(point.ts);
    return other === undefined || (close(point.accountValue, other.accountValue) && close(point.pnl, other.pnl));
  });
};

// Join month (fine), stored history (fine) and allTime (coarse) over the lookback (SPEC "Lookback and stitching").
export const buildSeries = (input: ScoreInput, config: ScoreConfig): Series | null => {
  if (!validateSeries(input.month)) return null;
  const flags: string[] = [];
  const monthRaw = toPoints(input.month);
  const end = monthRaw[monthRaw.length - 1].ts;
  const lookbackStart = end - config.lookbackDays * DAY_MS;
  const start = activeStart(input.allTime);
  if (start !== null && start > lookbackStart) flags.push("short-history");
  const from = start === null ? lookbackStart : Math.max(lookbackStart, start);
  const fine = (points: Point[]): SeriesPoint[] => points.filter(({ ts }) => ts >= from).map((p) => ({ ...p, fine: true }));

  if (!validateSeries(input.allTime)) {
    flags.push("no-alltime");
    return { points: fine(monthRaw), flags };
  }
  const allTime = toPoints(input.allTime);
  const lastAllTime = allTime[allTime.length - 1];
  const lastMonth = monthRaw[monthRaw.length - 1];
  const month = toPoints(input.month, lastAllTime.pnl - lastMonth.pnl);
  if (lastAllTime.ts !== end || !close(lastMonth.accountValue, lastAllTime.accountValue) || !agree(month, allTime)) {
    flags.push("stitch-mismatch");
    return { points: fine(monthRaw), flags };
  }

  const monthStart = month[0].ts;
  let history: Point[] = [];
  if (input.history !== null) {
    if (validateSeries(input.history)) {
      const stored = toPoints(input.history);
      if (agree(stored, allTime) && agree(stored, month)) {
        history = stored.filter(({ ts }) => ts >= from && ts < monthStart);
      } else {
        flags.push("history-mismatch");
      }
    } else {
      flags.push("history-mismatch");
    }
  }
  const coarseEnd = history.length > 0 ? history[0].ts : monthStart;
  const coarse = allTime.filter(({ ts }) => ts >= from && ts < coarseEnd).map((p) => ({ ...p, fine: false }));
  return { points: [...coarse, ...fine(history), ...fine(month)], flags };
};

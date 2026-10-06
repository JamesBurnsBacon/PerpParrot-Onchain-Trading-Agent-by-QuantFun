import type { WindowHistory } from "./types";

const DAY_MS = 86_400_000;

// Finite observations and safe, matching, strictly increasing timestamps are required for scoring (README §4.2).
export const validateSeries = (w: WindowHistory | null): boolean => {
  if (w === null || w.accountValueHistory.length < 2 || w.accountValueHistory.length !== w.pnlHistory.length) {
    return false;
  }
  return w.accountValueHistory.every(([timestamp, equity], i) =>
    Number.isSafeInteger(timestamp) && Number.isFinite(equity) &&
    Number.isSafeInteger(w.pnlHistory[i][0]) && Number.isFinite(w.pnlHistory[i][1]) &&
    timestamp === w.pnlHistory[i][0] && (i === 0 || timestamp > w.accountValueHistory[i - 1][0]),
  );
};

type Interval = { dt: number; r: number; pnl: number; day: number };

// Internal module helper: start-of-interval equity is the denominator (README §4.2).
export const usedIntervals = (w: WindowHistory): { intervals: Interval[]; flags: string[] } => {
  const intervals: Interval[] = [];
  const flags: string[] = [];
  for (let i = 1; i < w.accountValueHistory.length; i++) {
    const [previousTimestamp, equity] = w.accountValueHistory[i - 1];
    if (!(equity > 0)) {
      if (!flags.includes("zero-equity-interval")) flags.push("zero-equity-interval");
      continue;
    }
    const [timestamp, pnl] = w.pnlHistory[i];
    const delta = pnl - w.pnlHistory[i - 1][1];
    intervals.push({
      dt: (timestamp - previousTimestamp) / DAY_MS,
      r: delta / equity,
      pnl: delta,
      day: Math.floor(timestamp / DAY_MS),
    });
  }
  return { intervals, flags };
};

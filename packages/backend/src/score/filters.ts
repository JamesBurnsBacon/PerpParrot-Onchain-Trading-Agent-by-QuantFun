import { activeStart, DAY_MS, validateSeries } from "./stitch";
import type { FilterName, FilterStatus, Metrics, ScoreConfig, ScoreInput } from "./types";

// Days from the first funded allTime point to the last one; null without one (SPEC "Filters").
export const activeDays = (input: ScoreInput): number | null => {
  const start = activeStart(input.allTime);
  if (start === null || input.allTime === null) return null;
  const history = input.allTime.accountValueHistory;
  return (history[history.length - 1][0] - start) / DAY_MS;
};

// Any PnL change in the last `stillActiveDays` of the month window (SPEC "Filters").
const stillActive = (input: ScoreInput, config: ScoreConfig): FilterStatus => {
  if (!validateSeries(input.month)) return "unknown";
  const pnl = input.month.pnlHistory;
  const since = pnl[pnl.length - 1][0] - config.stillActiveDays * DAY_MS;
  for (let i = 1; i < pnl.length; i++) {
    if (pnl[i][0] >= since && pnl[i][1] - pnl[i - 1][1] !== 0) return "pass";
  }
  return "fail";
};

// Hard filters keep missing data as unknown (SPEC "Filters").
export const computeFilters = (
  input: ScoreInput,
  metrics: Metrics | null,
  config: ScoreConfig,
): Record<FilterName, FilterStatus> => {
  const days = activeDays(input);
  const monthValid = validateSeries(input.month);
  const flags = metrics?.flags ?? [];
  return {
    minAccountValue: !Number.isFinite(input.accountValue) ? "unknown" :
      input.accountValue >= config.minAccountValue ? "pass" : "fail",
    minActiveDays: !validateSeries(input.allTime) ? "unknown" :
      days !== null && days >= config.minActiveDays ? "pass" : "fail",
    stillActive: stillActive(input, config),
    minTrades: input.tradeCount === null ? "unknown" : input.tradeCount >= config.minTrades ? "pass" : "fail",
    notClosed: input.closed === null ? "unknown" : input.closed ? "fail" : "pass",
    minMonthPoints: !monthValid || input.month === null ? "unknown" :
      input.month.accountValueHistory.length >= config.minMonthPoints ? "pass" : "fail",
    minCoverage: metrics === null ? "unknown" : flags.includes("no-intervals") ? "fail" :
      metrics.skippedTimeShare <= config.maxSkippedTimeShare ? "pass" : "fail",
    noRuin: metrics === null ? "unknown" : flags.includes("ruin") ? "fail" : "pass",
  };
};

// Fail-closed: unknown passes only for filters explicitly allowed (SPEC "Eligibility").
export const isEligible = (statuses: Record<FilterName, FilterStatus>, config: ScoreConfig): boolean =>
  (Object.entries(statuses) as [FilterName, FilterStatus][]).every(([name, status]) =>
    status === "pass" || (status === "unknown" && config.allowUnknown.includes(name)));

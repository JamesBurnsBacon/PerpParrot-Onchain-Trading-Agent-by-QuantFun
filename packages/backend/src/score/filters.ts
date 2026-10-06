import { validateSeries } from "./returns";
import type { FilterName, FilterStatus, ScoreConfig, ScoreInput } from "./types";

// Hard filters use valid histories and preserve unknown data (README §4.2).
export const computeFilters = (input: ScoreInput, config: ScoreConfig): Record<FilterName, FilterStatus> => {
  let minActiveDays: FilterStatus = "unknown";
  if (input.allTime !== null && validateSeries(input.allTime)) {
    const history = input.allTime.accountValueHistory;
    const first = history.find(([, value]) => value > 0);
    minActiveDays = first !== undefined &&
      (history[history.length - 1][0] - first[0]) / 86_400_000 >= config.minActiveDays ? "pass" : "fail";
  }

  return {
    minAccountValue: !Number.isFinite(input.accountValue) ? "unknown" :
      input.accountValue >= config.minAccountValue ? "pass" : "fail",
    minActiveDays,
    minTrades: input.tradeCount === null ? "unknown" : input.tradeCount >= config.minTrades ? "pass" : "fail",
    notClosed: input.closed === null ? "unknown" : input.closed ? "fail" : "pass",
    minMonthPoints: input.month === null || !validateSeries(input.month) ? "unknown" :
      input.month.accountValueHistory.length >= config.minMonthPoints ? "pass" : "fail",
  };
};

// Eligibility is fail-closed unless unknown filters are explicitly allowed (README §4.2).
export const isEligible = (statuses: Record<FilterName, FilterStatus>, config: ScoreConfig): boolean =>
  Object.values(statuses).every((status) => status === "pass" || (status === "unknown" && config.allowUnknown));

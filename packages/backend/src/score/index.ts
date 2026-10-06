export type {
  Kind,
  TimePoint,
  WindowHistory,
  ScoreInput,
  FilterName,
  FilterStatus,
  Metrics,
  Candidate,
  FunnelStage,
  FunnelStep,
  ScoreConfig,
} from "./types";
export { parsePortfolio } from "./parse";
export { computeMetrics } from "./metrics";
export { validateSeries } from "./returns";
export { computeFilters, isEligible } from "./filters";
export { scoreCandidates, DEFAULT_CONFIG } from "./score";

// Score inputs and outputs (README §4.2, SPEC revision 2).
export type Kind = "trader" | "hypercore-vault" | "erc4626-vault";
export type Pool = "trader" | "vault";
export type TimePoint = readonly [tsMs: number, value: number];
export type WindowHistory = { accountValueHistory: TimePoint[]; pnlHistory: TimePoint[] };

export type ScoreInput = {
  address: string;
  kind: Kind;
  accountValue: number;
  closed: boolean | null;
  month: WindowHistory | null;
  allTime: WindowHistory | null;
  history: WindowHistory | null;
  tradeCount: number | null;
  links?: string[];
  avgLeverage?: number | null;
  timeInMarket?: number | null;
  medianHoldHours?: number | null;
  makerShare?: number | null;
};

export type FilterName =
  | "minAccountValue" | "minActiveDays" | "stillActive" | "minTrades"
  | "notClosed" | "minMonthPoints" | "minCoverage" | "noRuin";
export type FilterStatus = "pass" | "fail" | "unknown";

// "+inf" ranks above every number and null below (SPEC "Metrics").
export type Ratio = number | "+inf" | null;

export type Metrics = {
  sharpe: Ratio;
  sortino: Ratio;
  calmar: Ratio;
  maxDrawdown: number | null;
  consistency: number | null;
  periodReturn: number | null;
  annualisedReturn: number | null;
  annualisedVol: number | null;
  realizedVol: number | null;
  allTimeMaxDrawdown: number | null;
  lookbackDays: number;
  coveredDays: number;
  skippedTimeShare: number;
  fineTimeShare: number;
  flags: string[];
};

export type Percentiles = { sharpe: number; sortino: number; calmar: number; negMaxDrawdown: number; consistency: number };

export type Candidate = {
  address: string;
  kind: Kind;
  pool: Pool;
  activeDays: number | null;
  filters: Record<FilterName, FilterStatus>;
  eligible: boolean;
  metrics: Metrics | null;
  percentiles: Percentiles | null;
  scoreNumerator: number | null;
  score: number | null;
  rank: number | null;
  // `via`: the member of the representative's link unit that matched, when it is not the representative.
  cloneOf: { address: string; correlation: number | null; via?: string } | null;
  clones: string[];
  finalist: boolean;
  passthrough: {
    avgLeverage: number | null;
    timeInMarket: number | null;
    medianHoldHours: number | null;
    makerShare: number | null;
  };
};

export type FunnelStage = "universe" | FilterName | "ranked" | "distinct" | "finalists";
export type FunnelStep = { stage: FunnelStage; count: number };
export type FilterCounts = Record<FilterName, { pass: number; fail: number; unknown: number }>;
export type Correlation = { a: string; b: string; rho: number | null; linked: boolean };

export type ScoreConfig = {
  minAccountValue: number;
  minActiveDays: number;
  stillActiveDays: number;
  minTrades: number;
  minMonthPoints: number;
  lookbackDays: number;
  coarseGridDays: number;
  dustEquityFraction: number;
  maxSkippedTimeShare: number;
  cloneCorrelation: number;
  minOverlapDays: number;
  finalists: number;
  finalistSplit: "proportional" | { trader: number; vault: number };
  allowUnknown: FilterName[];
};

export type ScoreResult = {
  candidates: Candidate[];
  finalists: string[];
  correlations: Correlation[];
  funnel: FunnelStep[];
  filterCounts: FilterCounts;
  config: ScoreConfig;
};

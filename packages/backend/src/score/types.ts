// Score inputs and outputs (README §4.2).
export type Kind = "trader" | "hypercore-vault" | "erc4626-vault";
export type TimePoint = readonly [tsMs: number, value: number];
export type WindowHistory = { accountValueHistory: TimePoint[]; pnlHistory: TimePoint[] };

export type ScoreInput = {
  address: string;
  kind: Kind;
  accountValue: number;
  closed: boolean | null;
  month: WindowHistory | null;
  allTime: WindowHistory | null;
  tradeCount: number | null;
  avgLeverage?: number | null;
  timeInMarket?: number | null;
  medianHoldHours?: number | null;
  makerShare?: number | null;
};

export type FilterName = "minAccountValue" | "minActiveDays" | "minTrades" | "notClosed" | "minMonthPoints";
export type FilterStatus = "pass" | "fail" | "unknown";

export type Metrics = {
  sortino: number | null;
  calmar: number | null;
  maxDrawdown: number | null;
  pnlConsistency: number | null;
  realizedVol: number | null;
  flags: string[];
};

export type Candidate = {
  address: string;
  kind: Kind;
  filters: Record<FilterName, FilterStatus>;
  eligible: boolean;
  metrics: Metrics | null;
  percentiles: { sortino: number; calmar: number; negMaxDrawdown: number; pnlConsistency: number } | null;
  score: number | null;
  rank: number | null;
  finalist: boolean;
  passthrough: {
    avgLeverage: number | null;
    timeInMarket: number | null;
    medianHoldHours: number | null;
    makerShare: number | null;
  };
};

export type FunnelStage = "universe" | FilterName | "eligible" | "finalists";
export type FunnelStep = { stage: FunnelStage; count: number };

export type ScoreConfig = {
  minAccountValue: number;
  minActiveDays: number;
  minTrades: number;
  minMonthPoints: number;
  finalists: number;
  allowUnknown: boolean;
};

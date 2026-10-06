import type { FilterName, ScoreConfig } from "./types";

// README thresholds plus the provisional [tune] values (SPEC "Types").
export const DEFAULT_CONFIG: ScoreConfig = {
  minAccountValue: 10_000,
  minActiveDays: 30,
  stillActiveDays: 7,
  minTrades: 10,
  minMonthPoints: 25,
  lookbackDays: 90,
  coarseGridDays: 7,
  dustEquityFraction: 0.01,
  maxSkippedTimeShare: 0.2,
  cloneCorrelation: 0.9,
  minOverlapDays: 20,
  finalists: 25,
  finalistSplit: "proportional",
  allowUnknown: [],
};

export const FILTER_ORDER: FilterName[] = [
  "minAccountValue", "minActiveDays", "stillActive", "minTrades", "notClosed", "minMonthPoints", "minCoverage", "noRuin",
];

const isWholeNumber = (value: number, min: number): boolean => Number.isInteger(value) && value >= min;

// Invalid configuration throws and names the field (SPEC "Output").
export const validateConfig = (config: ScoreConfig): void => {
  const fail = (name: string): never => {
    throw new Error(`invalid config: ${name}`);
  };
  for (const name of ["finalists", "minMonthPoints", "lookbackDays"] as const) {
    if (!isWholeNumber(config[name], 1)) fail(name);
  }
  if (!isWholeNumber(config.minOverlapDays, 3)) fail("minOverlapDays");
  if (!Number.isFinite(config.coarseGridDays) || config.coarseGridDays <= 0) fail("coarseGridDays");
  for (const name of ["dustEquityFraction", "maxSkippedTimeShare"] as const) {
    if (!Number.isFinite(config[name]) || config[name] < 0 || config[name] > 1) fail(name);
  }
  if (!Number.isFinite(config.cloneCorrelation) || config.cloneCorrelation <= 0 || config.cloneCorrelation > 1) {
    fail("cloneCorrelation");
  }
  for (const name of ["minAccountValue", "minActiveDays", "stillActiveDays", "minTrades"] as const) {
    if (!Number.isFinite(config[name]) || config[name] < 0) fail(name);
  }
  const split = config.finalistSplit;
  if (split !== "proportional" && (typeof split !== "object" || split === null ||
    !isWholeNumber(split.trader, 0) || !isWholeNumber(split.vault, 0) || split.trader + split.vault !== config.finalists)) {
    fail("finalistSplit");
  }
  if (!Array.isArray(config.allowUnknown) || config.allowUnknown.some((name) => !FILTER_ORDER.includes(name))) {
    fail("allowUnknown");
  }
};

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
  finalists: 40,
  finalistSplit: "proportional",
  allowUnknown: [],
  pureTakerMakerShare: 0.05,
  pureTakerPenalty: 0.02,
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
  if (!Number.isFinite(config.pureTakerMakerShare) || config.pureTakerMakerShare < 0 || config.pureTakerMakerShare > 1) {
    fail("pureTakerMakerShare");
  }
  // The penalty is applied in whole numerator units from a 0.001 grid (SPEC "Ranking").
  const penalty = config.pureTakerPenalty;
  if (!Number.isFinite(penalty) || penalty < 0 || penalty > 1 || Math.abs(penalty * 1000 - Math.round(penalty * 1000)) > 1e-9) {
    fail("pureTakerPenalty");
  }
  if (!Array.isArray(config.allowUnknown) || config.allowUnknown.some((name) => !FILTER_ORDER.includes(name))) {
    fail("allowUnknown");
  }
};

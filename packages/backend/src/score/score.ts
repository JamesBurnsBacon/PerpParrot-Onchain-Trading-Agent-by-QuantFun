import { computeFilters, isEligible } from "./filters";
import { computeMetrics } from "./metrics";
import { validateSeries } from "./returns";
import type { Candidate, FilterName, FunnelStep, Metrics, ScoreConfig, ScoreInput } from "./types";

// Default screening thresholds and finalist count (README §4.2).
export const DEFAULT_CONFIG: ScoreConfig = {
  minAccountValue: 10_000,
  minActiveDays: 30,
  minTrades: 10,
  minMonthPoints: 25,
  finalists: 25,
  allowUnknown: false,
};

const FILTER_ORDER: FilterName[] = ["minAccountValue", "minActiveDays", "minTrades", "notClosed", "minMonthPoints"];

const validateConfig = (config: ScoreConfig): void => {
  for (const name of ["minAccountValue", "minActiveDays", "minTrades", "minMonthPoints", "finalists"] as const) {
    const value = config[name];
    if (!Number.isFinite(value) || value < 0 ||
      ((name === "finalists" || name === "minMonthPoints") && (!Number.isInteger(value) || value < 1))) {
      throw new Error(`invalid config: ${name}`);
    }
  }
};

const compareAddresses = (a: Candidate, b: Candidate): number => {
  const left = a.address.toLowerCase();
  const right = b.address.toLowerCase();
  return left < right ? -1 : left > right ? 1 : 0;
};

// Equal values share their midrank percentile; null is strictly worst (README §4.2).
const percentileMap = (values: (number | null)[]): Map<number | null, number> => {
  const sorted = [...values].sort((a, b) => a === b ? 0 : a === null ? -1 : b === null ? 1 : a - b);
  const result = new Map<number | null, number>();
  for (let start = 0; start < sorted.length;) {
    let end = start + 1;
    while (end < sorted.length && sorted[end] === sorted[start]) end++;
    result.set(sorted[start], sorted.length === 1 ? 0.5 : (start + (end - start - 1) / 2) / (sorted.length - 1));
    start = end;
  }
  return result;
};

const negMaxDrawdown = (metrics: Metrics): number | null =>
  metrics.maxDrawdown === null ? null : -metrics.maxDrawdown;

// Rank eligible histories, then report the cumulative screening funnel (README §4.2).
export const scoreCandidates = (
  inputs: ScoreInput[],
  overrides: Partial<ScoreConfig> = {},
): { candidates: Candidate[]; finalists: string[]; funnel: FunnelStep[]; config: ScoreConfig } => {
  const config: ScoreConfig = { ...DEFAULT_CONFIG, ...overrides };
  validateConfig(config);
  const addresses = new Set<string>();
  for (const input of inputs) {
    const address = input.address.toLowerCase();
    if (addresses.has(address)) throw new Error(`duplicate address: ${input.address}`);
    addresses.add(address);
  }

  const candidates = inputs.map((input): Candidate => {
    const filters = computeFilters(input, config);
    return {
      address: input.address,
      kind: input.kind,
      filters,
      eligible: isEligible(filters, config),
      metrics: input.month !== null && validateSeries(input.month) ? computeMetrics(input.month) : null,
      percentiles: null,
      score: null,
      rank: null,
      finalist: false,
      passthrough: {
        avgLeverage: input.avgLeverage ?? null,
        timeInMarket: input.timeInMarket ?? null,
        medianHoldHours: input.medianHoldHours ?? null,
        makerShare: input.makerShare ?? null,
      },
    };
  });

  const rankable = candidates.filter((candidate): candidate is Candidate & { metrics: Metrics } =>
    candidate.eligible && candidate.metrics !== null,
  );
  const sortino = percentileMap(rankable.map(({ metrics }) => metrics.sortino));
  const calmar = percentileMap(rankable.map(({ metrics }) => metrics.calmar));
  const drawdown = percentileMap(rankable.map(({ metrics }) => negMaxDrawdown(metrics)));
  const consistency = percentileMap(rankable.map(({ metrics }) => metrics.pnlConsistency));
  const ranked = rankable.map((candidate) => {
    const { metrics } = candidate;
    const percentiles = {
      sortino: sortino.get(metrics.sortino)!,
      calmar: calmar.get(metrics.calmar)!,
      negMaxDrawdown: drawdown.get(negMaxDrawdown(metrics))!,
      pnlConsistency: consistency.get(metrics.pnlConsistency)!,
    };
    return {
      ...candidate,
      percentiles,
      score: (percentiles.sortino + percentiles.calmar + percentiles.negMaxDrawdown + percentiles.pnlConsistency) / 4,
    };
  }).sort((a, b) => b.score - a.score || compareAddresses(a, b));
  ranked.forEach((candidate, index) => {
    candidate.rank = index + 1;
    candidate.finalist = index < config.finalists;
  });
  const unranked = candidates.filter((candidate) => !candidate.eligible || candidate.metrics === null)
    .sort(compareAddresses);
  const finalists = ranked.filter((candidate) => candidate.finalist).map((candidate) => candidate.address);

  const funnel: FunnelStep[] = [{ stage: "universe", count: candidates.length }];
  let remaining = candidates;
  for (const stage of FILTER_ORDER) {
    remaining = remaining.filter(({ filters }) =>
      filters[stage] === "pass" || (filters[stage] === "unknown" && config.allowUnknown),
    );
    funnel.push({ stage, count: remaining.length });
  }
  funnel.push({ stage: "eligible", count: ranked.length }, { stage: "finalists", count: finalists.length });
  return { candidates: [...ranked, ...unranked], finalists, funnel, config };
};

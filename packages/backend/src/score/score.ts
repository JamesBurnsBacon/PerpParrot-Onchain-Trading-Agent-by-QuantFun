import { correlation, dailyReturns, linked, linkGroups } from "./clones";
import { DEFAULT_CONFIG, FILTER_ORDER, validateConfig } from "./config";
import { activeDays, computeFilters, isEligible } from "./filters";
import { type Analysis, analyse } from "./metrics";
import type {
  Candidate, Correlation, FilterCounts, FunnelStep, Metrics, Percentiles, Pool, Ratio, ScoreConfig, ScoreInput, ScoreResult,
} from "./types";

export { DEFAULT_CONFIG } from "./config";

const TERMS = [
  ["sharpe", 1], ["sortino", 1], ["calmar", 1], ["negMaxDrawdown", 1], ["consistency", 2],
] as const satisfies readonly (readonly [keyof Percentiles, number])[];
const WEIGHT_TOTAL = TERMS.reduce((sum, [, weight]) => sum + weight, 0);

// null < every number < "+inf"; equal values compare equal (SPEC "Ranking").
const compareValues = (a: Ratio, b: Ratio): number => {
  if (a === b) return 0;
  if (a === null || b === "+inf") return -1;
  if (b === null || a === "+inf") return 1;
  return a < b ? -1 : a > b ? 1 : 0;
};

const termValue = (metrics: Metrics, term: keyof Percentiles): Ratio =>
  term === "negMaxDrawdown" ? metrics.maxDrawdown === null ? null : -metrics.maxDrawdown : metrics[term];

const compareAddresses = (a: { address: string }, b: { address: string }): number => {
  const left = a.address.toLowerCase();
  const right = b.address.toLowerCase();
  return left < right ? -1 : left > right ? 1 : 0;
};

// k = 2L + E - 1 for each value, counting strictly worse (L) and equal (E) values in the pool.
const rankNumerators = (values: Ratio[]): number[] =>
  values.map((value) => {
    let worse = 0;
    let equal = 0;
    for (const other of values) {
      const order = compareValues(other, value);
      if (order < 0) worse++;
      else if (order === 0) equal++;
    }
    return 2 * worse + equal - 1;
  });

export type PoolRank = { address: string; percentiles: Percentiles; scoreNumerator: number; score: number; rank: number };

// Exact integer ranking inside one pool; ties by raw Sharpe, then address (SPEC "Ranking").
export const rankPool = (entries: { address: string; metrics: Metrics }[]): PoolRank[] => {
  const count = entries.length;
  const numerators = Object.fromEntries(TERMS.map(([term]) =>
    [term, rankNumerators(entries.map(({ metrics }) => termValue(metrics, term)))])) as Record<keyof Percentiles, number[]>;
  return entries.map(({ address, metrics }, i) => {
    const percentiles = Object.fromEntries(TERMS.map(([term]) =>
      [term, count === 1 ? 0.5 : numerators[term][i] / (2 * (count - 1))])) as Percentiles;
    const scoreNumerator = count === 1 ? 0 : TERMS.reduce((sum, [term, weight]) => sum + weight * numerators[term][i], 0);
    return { address, metrics, percentiles, scoreNumerator, score: count === 1 ? 0.5 : scoreNumerator / (2 * WEIGHT_TOTAL * (count - 1)) };
  }).sort((a, b) => b.scoreNumerator - a.scoreNumerator || compareValues(b.metrics.sharpe, a.metrics.sharpe) || compareAddresses(a, b))
    .map(({ address, percentiles, scoreNumerator, score }, index) => ({ address, percentiles, scoreNumerator, score, rank: index + 1 }));
};

const poolOf = (input: ScoreInput): Pool => input.kind === "trader" ? "trader" : "vault";

type Ranked = Candidate & { metrics: Metrics; scoreNumerator: number; poolSize: number };

// Scores from different pools compare exactly as fractions n / (12(N - 1)), 1/2 when N = 1 (SPEC "Ranking").
const compareCrossPool = (a: Ranked, b: Ranked): number => {
  const fraction = (c: Ranked): [number, number] =>
    c.poolSize === 1 ? [1, 2] : [c.scoreNumerator, 2 * WEIGHT_TOTAL * (c.poolSize - 1)];
  const [an, ad] = fraction(a);
  const [bn, bd] = fraction(b);
  return bn * ad - an * bd || compareValues(b.metrics.sharpe, a.metrics.sharpe) || compareAddresses(a, b);
};

// Slots per pool: proportional with largest remainder, or fixed with spill-over (SPEC "Finalists").
const finalistSlots = (representatives: Record<Pool, number>, config: ScoreConfig): Record<Pool, number> => {
  const total = representatives.trader + representatives.vault;
  const slots = config.finalists;
  if (total <= slots) return { ...representatives };
  const split = config.finalistSplit;
  if (split !== "proportional") {
    const trader = Math.min(split.trader, representatives.trader);
    const vault = Math.min(split.vault, representatives.vault);
    return {
      trader: Math.min(representatives.trader, trader + (split.vault - vault)),
      vault: Math.min(representatives.vault, vault + (split.trader - trader)),
    };
  }
  const result = {
    trader: Math.floor((slots * representatives.trader) / total),
    vault: Math.floor((slots * representatives.vault) / total),
  };
  const remainder = { trader: (slots * representatives.trader) % total, vault: (slots * representatives.vault) % total };
  for (let left = slots - result.trader - result.vault; left > 0; left--) {
    const pool: Pool = remainder.vault > remainder.trader ? "vault" : "trader";
    result[pool]++;
    remainder[pool] = -1;
  }
  for (const [pool, other] of [["trader", "vault"], ["vault", "trader"]] as const) {
    if (representatives[pool] > 0 && result[pool] === 0 && result[other] >= 2) {
      result[pool] = 1;
      result[other]--;
    }
  }
  return result;
};

// Filter, rank within pools, group clones, then cut the finalists (README §4.2, SPEC revision 2).
export const scoreCandidates = (inputs: ScoreInput[], overrides: Partial<ScoreConfig> = {}): ScoreResult => {
  const config: ScoreConfig = { ...DEFAULT_CONFIG, ...overrides };
  validateConfig(config);
  const byAddress = new Map<string, ScoreInput>();
  for (const input of inputs) {
    const address = input.address.toLowerCase();
    if (byAddress.has(address)) throw new Error(`duplicate address: ${input.address}`);
    byAddress.set(address, input);
  }
  const inputOf = (address: string): ScoreInput => byAddress.get(address.toLowerCase())!;

  const analyses = new Map<string, Analysis>();
  const candidates = inputs.map((input): Candidate => {
    const analysis = analyse(input, config);
    if (analysis !== null) analyses.set(input.address, analysis);
    const metrics = analysis?.metrics ?? null;
    const filters = computeFilters(input, metrics, config);
    return {
      address: input.address,
      kind: input.kind,
      pool: poolOf(input),
      activeDays: activeDays(input),
      filters,
      eligible: isEligible(filters, config),
      metrics,
      percentiles: null,
      scoreNumerator: null,
      score: null,
      rank: null,
      cloneOf: null,
      clones: [],
      finalist: false,
      passthrough: {
        avgLeverage: input.avgLeverage ?? null,
        timeInMarket: input.timeInMarket ?? null,
        medianHoldHours: input.medianHoldHours ?? null,
        makerShare: input.makerShare ?? null,
      },
    };
  });

  const rankable = candidates.filter((c): c is Candidate & { metrics: Metrics } =>
    c.eligible && c.metrics !== null && !c.metrics.flags.includes("no-intervals") && !c.metrics.flags.includes("overflow"));
  const ranked: Ranked[] = [];
  for (const pool of ["trader", "vault"] as const) {
    const members = rankable.filter((c) => c.pool === pool);
    const byPoolAddress = new Map(members.map((c) => [c.address, c]));
    for (const entry of rankPool(members)) {
      ranked.push({ ...byPoolAddress.get(entry.address)!, ...entry, poolSize: members.length });
    }
  }
  ranked.sort(compareCrossPool);

  // Link units are visited at their heads, in cross-pool order (SPEC "Clone grouping").
  const groups = linkGroups(inputs);
  const units = new Map<string, Ranked[]>();
  for (const candidate of ranked) {
    const group = groups.get(candidate.address.toLowerCase())!;
    const unit = units.get(group);
    if (unit === undefined) units.set(group, [candidate]);
    else unit.push(candidate);
  }
  const returns = new Map(ranked.map((c) => [c.address, dailyReturns(analyses.get(c.address)!)]));
  const rho = (a: string, b: string) => correlation(returns.get(a)!, returns.get(b)!, config.minOverlapDays);
  // A head is compared with each earlier representative's link unit (the representative, then its
  // link-clones), never with correlation clones, so correlation cannot chain (SPEC "Clone grouping").
  const representativeUnits: { representative: Ranked; members: Ranked[] }[] = [];
  for (const [head, ...members] of units.values()) {
    search: for (const unit of representativeUnits) {
      for (const account of unit.members) {
        const value = rho(head.address, account.address);
        if (value !== null && value >= config.cloneCorrelation) {
          const { address } = unit.representative;
          head.cloneOf = account === unit.representative
            ? { address, correlation: value }
            : { address, correlation: value, via: account.address };
          break search;
        }
      }
    }
    if (head.cloneOf === null) representativeUnits.push({ representative: head, members: [head, ...members] });
    for (const member of members) {
      member.cloneOf = { address: head.cloneOf?.address ?? head.address, correlation: null };
    }
  }
  const representatives = representativeUnits.map(({ representative }) => representative);
  // Unit members can be discovered early; clone lists still follow cross-pool order (SPEC "Clone grouping").
  const representativeByAddress = new Map(representatives.map((c) => [c.address, c]));
  for (const candidate of ranked) {
    if (candidate.cloneOf !== null) representativeByAddress.get(candidate.cloneOf.address)!.clones.push(candidate.address);
  }

  const count = (pool: Pool) => representatives.filter((c) => c.pool === pool).length;
  const slots = finalistSlots({ trader: count("trader"), vault: count("vault") }, config);
  const taken: Record<Pool, number> = { trader: 0, vault: 0 };
  for (const representative of representatives) {
    if (taken[representative.pool] < slots[representative.pool]) {
      taken[representative.pool]++;
      representative.finalist = true;
    }
  }
  const finalists = representatives.filter((c) => c.finalist).map((c) => c.address);
  const correlations: Correlation[] = [];
  for (let i = 0; i < finalists.length; i++) {
    for (let j = i + 1; j < finalists.length; j++) {
      correlations.push({
        a: finalists[i],
        b: finalists[j],
        rho: rho(finalists[i], finalists[j]),
        linked: linked(inputOf(finalists[i]), inputOf(finalists[j])),
      });
    }
  }

  const rankedAddresses = new Set(ranked.map((c) => c.address));
  const unranked = candidates.filter((c) => !rankedAddresses.has(c.address)).sort(compareAddresses);
  const output = [...ranked.map(({ poolSize: _, ...candidate }): Candidate => candidate), ...unranked];

  const funnel: FunnelStep[] = [{ stage: "universe", count: candidates.length }];
  let remaining = candidates;
  for (const stage of FILTER_ORDER) {
    remaining = remaining.filter(({ filters }) =>
      filters[stage] === "pass" || (filters[stage] === "unknown" && config.allowUnknown.includes(stage)));
    funnel.push({ stage, count: remaining.length });
  }
  funnel.push(
    { stage: "ranked", count: ranked.length },
    { stage: "distinct", count: representatives.length },
    { stage: "finalists", count: finalists.length },
  );
  const filterCounts = Object.fromEntries(FILTER_ORDER.map((name) => [name, {
    pass: candidates.filter((c) => c.filters[name] === "pass").length,
    fail: candidates.filter((c) => c.filters[name] === "fail").length,
    unknown: candidates.filter((c) => c.filters[name] === "unknown").length,
  }])) as FilterCounts;

  return { candidates: output, finalists, correlations, funnel, filterCounts, config };
};

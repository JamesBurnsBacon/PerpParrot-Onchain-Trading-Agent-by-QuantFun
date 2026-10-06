import { describe, expect, test } from "bun:test";
import { DEFAULT_CONFIG, scoreCandidates, type ScoreConfig, type ScoreInput, type ScoreResult } from "../../src/score";
import clones from "../fixtures/score/clones.json";
import ranking from "../fixtures/score/ranking-set.json";
import sampleExpected from "../fixtures/score/portfolio-sample.expected.json";
import { expectFinite, expectOutput, sampleInputs, shuffle, toInput, type RawInput } from "./helpers";

type Fixture = { inputs: RawInput[]; expected: Record<string, unknown> };
const rankingInputs = (ranking as unknown as Fixture).inputs.map(toInput);
const cloneInputs = (clones as unknown as Fixture).inputs.map(toInput);
const configOf = (expected: unknown): Partial<ScoreConfig> => (expected as ScoreResult).config;

// Every expected output carries its full config, so each scenario reruns exactly what the reference ran.
const scenarios: { name: string; inputs: ScoreInput[]; expected: unknown }[] = [
  { name: "ranking finalists-3", inputs: rankingInputs, expected: ranking.expected["finalists-3"] },
  { name: "ranking single", inputs: rankingInputs.slice(0, 1), expected: ranking.expected.single },
  { name: "ranking split", inputs: rankingInputs, expected: ranking.expected.split },
  { name: "sample strict", inputs: sampleInputs, expected: sampleExpected.strict },
  { name: "sample permissive", inputs: sampleInputs, expected: sampleExpected.permissive },
  ...Object.entries((clones as unknown as Fixture).expected)
    .map(([name, expected]) => ({ name: `clones ${name}`, inputs: cloneInputs, expected })),
];

describe("scoreCandidates fixtures (SPEC Output)", () => {
  for (const scenario of scenarios) {
    test(`full output: ${scenario.name}`, () => {
      expectOutput(scoreCandidates(scenario.inputs, configOf(scenario.expected)), scenario.expected);
    });

    test(`invariants: ${scenario.name}`, () => {
      const config = configOf(scenario.expected);
      const result = scoreCandidates(scenario.inputs, config);
      expect(scoreCandidates(shuffle(scenario.inputs), config)).toEqual(result);
      expectFinite(result);

      const counts = result.funnel.map(({ count }) => count);
      counts.slice(1).forEach((count, i) => expect(count).toBeLessThanOrEqual(counts[i]));
      const ranked = result.candidates.filter(({ rank }) => rank !== null);
      const representatives = ranked.filter(({ cloneOf }) => cloneOf === null);
      expect(result.funnel.slice(-3)).toEqual([
        { stage: "ranked", count: ranked.length },
        { stage: "distinct", count: representatives.length },
        { stage: "finalists", count: result.finalists.length },
      ]);

      // Clones are never finalists, point at a representative, and are listed by it.
      for (const candidate of ranked) {
        if (candidate.cloneOf === null) continue;
        expect(candidate.finalist).toBe(false);
        const representative = ranked.find(({ address }) => address === candidate.cloneOf!.address)!;
        expect(representative.cloneOf).toBeNull();
        expect(representative.clones).toContain(candidate.address);
        if (candidate.cloneOf.correlation !== null) {
          expect(candidate.cloneOf.correlation).toBeGreaterThanOrEqual(result.config.cloneCorrelation);
        }
      }
      expect(result.finalists).toEqual(result.candidates.filter(({ finalist }) => finalist).map(({ address }) => address));
      expect(result.finalists.length).toBeLessThanOrEqual(result.config.finalists);
      expect(result.correlations).toHaveLength(result.finalists.length * (result.finalists.length - 1) / 2);
      for (const name of Object.keys(result.filterCounts) as (keyof typeof result.filterCounts)[]) {
        const { pass, fail, unknown } = result.filterCounts[name];
        expect(pass + fail + unknown).toBe(result.candidates.length);
      }
    });
  }
});

describe("scoreCandidates behaviour", () => {
  test("a near-duplicate takes no finalist slot, so the slot goes to the next distinct strategy", () => {
    const [first] = rankingInputs.filter((input) => scoreCandidates([input]).candidates[0].rank !== null);
    const copy = { ...first, address: `${first.address}-copy` };
    const result = scoreCandidates([first, copy], { finalists: 2 });
    const twin = result.candidates.find(({ address }) => address === copy.address)!;
    expect(twin.cloneOf?.address ?? first.address).toBe(first.address);
    expect(result.finalists).toEqual([result.candidates[0].address]);
  });

  test("a link groups accounts whatever their correlation", () => {
    const ranked = rankingInputs.filter((input) => scoreCandidates([input]).candidates[0].rank !== null).slice(0, 2);
    const linked = [ranked[0], { ...ranked[1], links: [ranked[0].address.toUpperCase()] }];
    const result = scoreCandidates(linked);
    const clone = result.candidates.find(({ cloneOf }) => cloneOf !== null)!;
    expect(clone.cloneOf!.correlation).toBeNull();
    expect(result.finalists).toHaveLength(1);
    expect(result.correlations).toEqual([]);
  });

  for (const address of ["Dup", "DUP"]) {
    test(`rejects duplicate address ${address}`, () => {
      expect(() => scoreCandidates([{ ...rankingInputs[0], address: "dup" }, { ...rankingInputs[0], address }]))
        .toThrow("duplicate address");
    });
  }

  const invalidConfigs: [string, Partial<ScoreConfig>][] = [
    ...(["finalists", "minMonthPoints", "lookbackDays"] as const)
      .flatMap((key) => [0, 1.5, -1, NaN, Infinity].map((value): [string, Partial<ScoreConfig>] => [key, { [key]: value }])),
    ...(["minAccountValue", "minActiveDays", "stillActiveDays", "minTrades"] as const)
      .flatMap((key) => [-1, NaN, Infinity, -Infinity].map((value): [string, Partial<ScoreConfig>] => [key, { [key]: value }])),
    ...(["dustEquityFraction", "maxSkippedTimeShare"] as const)
      .flatMap((key) => [-0.1, 1.1, NaN].map((value): [string, Partial<ScoreConfig>] => [key, { [key]: value }])),
    ["cloneCorrelation", { cloneCorrelation: 0 }], ["cloneCorrelation", { cloneCorrelation: 1.01 }],
    ["minOverlapDays", { minOverlapDays: 2 }], ["minOverlapDays", { minOverlapDays: 20.5 }],
    ["coarseGridDays", { coarseGridDays: 0 }],
    ["finalistSplit", { finalistSplit: { trader: 20, vault: 4 } }],
    ["finalistSplit", { finalistSplit: { trader: -1, vault: 26 } }],
    ["allowUnknown", { allowUnknown: ["minTrade" as "minTrades"] }],
    ...[-0.1, 1.1, NaN].map((value): [string, Partial<ScoreConfig>] => ["pureTakerMakerShare", { pureTakerMakerShare: value }]),
    ...[-0.01, 1.5, 0.0205, NaN].map((value): [string, Partial<ScoreConfig>] => ["pureTakerPenalty", { pureTakerPenalty: value }]),
  ];
  for (const [field, config] of invalidConfigs) {
    test(`rejects invalid config ${JSON.stringify(config)} naming ${field}`, () => {
      expect(() => scoreCandidates([], config)).toThrow(`invalid config: ${field}`);
    });
  }

  test("empty universe has zero counts and no ranked candidates", () => {
    const result = scoreCandidates([]);
    expect(result.candidates).toEqual([]);
    expect(result.finalists).toEqual([]);
    expect(result.correlations).toEqual([]);
    expect(result.config).toEqual(DEFAULT_CONFIG);
    expect(result.funnel.map(({ count }) => count)).toEqual(Array(12).fill(0));
    expect(Object.values(result.filterCounts)).toEqual(Array(8).fill({ pass: 0, fail: 0, unknown: 0 }));
  });

  test("an unknown month can be eligible but is never ranked", () => {
    const allFilters = Object.keys(scoreCandidates([]).filterCounts) as ScoreConfig["allowUnknown"];
    const result = scoreCandidates([{ ...rankingInputs[0], month: null }], { allowUnknown: allFilters });
    expect(result.candidates[0].eligible).toBe(true);
    expect(result.candidates[0].metrics).toBeNull();
    expect(result.candidates[0].rank).toBeNull();
    expect(result.funnel.slice(-3).map(({ count }) => count)).toEqual([0, 0, 0]);
  });

  test("an overflowing curve stays eligible but is never ranked (SPEC Ranking)", () => {
    const day = 86_400_000;
    const result = scoreCandidates([{
      address: "overflow", kind: "trader", accountValue: 10_000, closed: false, tradeCount: 10,
      history: null, allTime: null,
      month: {
        accountValueHistory: [[0, 1], [day, 1], [2 * day, 1]],
        pnlHistory: [[0, 0], [day, 1e200], [2 * day, 2e200]],
      },
    }], { minMonthPoints: 2, allowUnknown: ["minActiveDays"] });
    const [candidate] = result.candidates;
    expect(candidate.metrics!.maxDrawdown).toBeNull();
    expect(candidate.metrics!.flags).toContain("overflow");
    expect(candidate.metrics!.flags).toEqual([...new Set(candidate.metrics!.flags)].sort());
    expect(candidate.eligible).toBe(true);
    expect(candidate.rank).toBeNull();
    expect(candidate.score).toBeNull();
    expect(candidate.scoreNumerator).toBeNull();
    expect(candidate.percentiles).toBeNull();
    expect(candidate.finalist).toBe(false);
    expect(result.finalists).toEqual([]);
    expect(result.funnel.slice(0, 9).map(({ count }) => count)).toEqual(Array(9).fill(1));
    expect(result.funnel.slice(-3)).toEqual([
      { stage: "ranked", count: 0 },
      { stage: "distinct", count: 0 },
      { stage: "finalists", count: 0 },
    ]);
    expectFinite(result);
  });

  test("preserves supplied passthrough values, including zero and null", () => {
    const passthrough = { avgLeverage: 2, timeInMarket: 0, medianHoldHours: null, makerShare: 0.25 };
    expect(scoreCandidates([{ ...rankingInputs[0], ...passthrough }]).candidates[0].passthrough).toEqual(passthrough);
  });

  test("a pure taker loses only score: same percentiles, numerator minus whole penalty units (README §4.2)", () => {
    const config = { finalists: 3, pureTakerPenalty: 0.1 };
    const base = scoreCandidates(rankingInputs, config);
    const target = base.candidates.find(({ pool, rank }) => pool === "trader" && rank === 1)!;
    const poolSize = base.candidates.filter(({ pool, rank }) => pool === "trader" && rank !== null).length;
    const units = Math.round(0.1 * 12 * (poolSize - 1));
    const inputs = rankingInputs.map((input) => input.address === target.address ? { ...input, makerShare: 0 } : input);
    const penalised = scoreCandidates(inputs, config).candidates.find(({ address }) => address === target.address)!;
    expect(units).toBeGreaterThan(0);
    expect(penalised.makerPenalty).toBe(Math.min(units, target.scoreNumerator!));
    expect(penalised.scoreNumerator).toBe(target.scoreNumerator! - penalised.makerPenalty!);
    expect(penalised.score).toBe(penalised.scoreNumerator! / (12 * (poolSize - 1)));
    expect(penalised.percentiles).toEqual(target.percentiles);
    expect(penalised.passthrough.makerShare).toBe(0);
    expect(base.candidates.every(({ makerPenalty, rank }) => makerPenalty === (rank === null ? null : 0))).toBe(true);
  });

  test("unranked addresses sort case-insensitively and keep their spelling", () => {
    const closed = (address: string): ScoreInput => ({ ...rankingInputs[0], address, closed: true });
    expect(scoreCandidates(["b", "A", "d", "C"].map(closed)).candidates.map(({ address }) => address))
      .toEqual(["A", "b", "C", "d"]);
  });
});

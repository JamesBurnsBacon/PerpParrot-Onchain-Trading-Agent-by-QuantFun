import { describe, expect, test } from "bun:test";
import { DEFAULT_CONFIG, parsePortfolio, scoreCandidates, type ScoreConfig, type ScoreInput, type TimePoint } from "../../src/score";
import ranking from "../fixtures/score/ranking-set.json";
import sample from "../fixtures/score/portfolio-sample.json";
import sampleExpected from "../fixtures/score/portfolio-sample.expected.json";

const rankingInputs = ranking.inputs.map((input): ScoreInput => {
  if (input.kind !== "trader" && input.kind !== "hypercore-vault" && input.kind !== "erc4626-vault") {
    throw new Error(`invalid fixture kind: ${input.kind}`);
  }
  return {
    ...input,
    kind: input.kind,
    month: input.month === null ? null : {
      accountValueHistory: input.month.accountValueHistory.map(([ts, value]): TimePoint => [ts, value]),
      pnlHistory: input.month.pnlHistory.map(([ts, value]): TimePoint => [ts, value]),
    },
    allTime: input.allTime === null ? null : {
      accountValueHistory: input.allTime.accountValueHistory.map(([ts, value]): TimePoint => [ts, value]),
      pnlHistory: input.allTime.pnlHistory.map(([ts, value]): TimePoint => [ts, value]),
    },
  };
});

const sampleInputs = sample.map((entry): ScoreInput => ({
  address: entry.id,
  kind: "trader",
  accountValue: entry.accountValue,
  closed: entry.closed,
  tradeCount: entry.tradeCount,
  ...parsePortfolio(entry.portfolio),
}));

// Compare the complete fixture output, allowing only numeric rounding (README §4.2).
const expectOutput = (actual: unknown, expected: unknown, path = "result"): void => {
  if (typeof expected === "number") {
    expect(typeof actual, path).toBe("number");
    if (typeof actual !== "number") throw new Error(`non-numeric ${path}`);
    expect(Math.abs(actual - expected), path).toBeLessThanOrEqual(1e-9);
  } else if (Array.isArray(expected)) {
    expect(Array.isArray(actual), path).toBe(true);
    if (!Array.isArray(actual)) throw new Error(`non-array ${path}`);
    expect(actual.length, path).toBe(expected.length);
    expected.forEach((value: unknown, i: number) => expectOutput(actual[i], value, `${path}[${i}]`));
  } else if (expected !== null && typeof expected === "object") {
    if (actual === null || typeof actual !== "object" || Array.isArray(actual)) {
      throw new Error(`non-object ${path}`);
    }
    expect(Object.keys(actual).sort(), path).toEqual(Object.keys(expected).sort());
    for (const [key, value] of Object.entries(expected)) {
      expectOutput((actual as Record<string, unknown>)[key], value, `${path}.${key}`);
    }
  } else {
    expect(actual, path).toBe(expected);
  }
};

const expectFiniteOutput = (value: unknown): void => {
  if (typeof value === "number") expect(Number.isFinite(value)).toBe(true);
  else if (value !== null && typeof value === "object") Object.values(value).forEach(expectFiniteOutput);
};

const shuffle = (inputs: ScoreInput[]): ScoreInput[] => {
  const result = [...inputs];
  let seed = 42;
  for (let i = result.length - 1; i > 0; i--) {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    const j = seed % (i + 1);
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
};

const scenarios = [
  { name: "finalists-3", inputs: rankingInputs, config: { finalists: 3 }, expected: ranking.expected["finalists-3"] },
  { name: "single", inputs: rankingInputs.slice(0, 1), config: undefined, expected: ranking.expected.single },
  { name: "strict", inputs: sampleInputs, config: undefined, expected: sampleExpected.strict },
  { name: "permissive", inputs: sampleInputs, config: { allowUnknown: true, finalists: 5 }, expected: sampleExpected.permissive },
];

describe("scoreCandidates (README §4.2)", () => {
  for (const scenario of scenarios) {
    test(`full output: ${scenario.name}`, () => {
      expectOutput(scoreCandidates(scenario.inputs, scenario.config), scenario.expected);
    });

    test(`order invariance and output properties: ${scenario.name}`, () => {
      const result = scoreCandidates(scenario.inputs, scenario.config);
      expect(scoreCandidates(shuffle(scenario.inputs), scenario.config)).toEqual(result);
      for (const candidate of result.candidates) {
        if (candidate.percentiles !== null) {
          for (const value of Object.values(candidate.percentiles)) {
            expect(value).toBeGreaterThanOrEqual(0);
            expect(value).toBeLessThanOrEqual(1);
          }
        }
      }
      result.funnel.slice(1).forEach((step, i) => expect(step.count).toBeLessThanOrEqual(result.funnel[i].count));
      expect(result.funnel.slice(-2)).toEqual([
        { stage: "eligible", count: result.candidates.filter((candidate) => candidate.rank !== null).length },
        { stage: "finalists", count: result.finalists.length },
      ]);
      expectFiniteOutput(result);
    });
  }

  for (const address of [rankingInputs[0].address, rankingInputs[0].address.toUpperCase()]) {
    test(`rejects duplicate address ${address}`, () => {
      expect(() => scoreCandidates([rankingInputs[0], { ...rankingInputs[0], address }])).toThrow("duplicate address");
    });
  }

  const invalidConfigs: Partial<ScoreConfig>[] = [
    { finalists: 0 }, { finalists: 1.5 }, { minMonthPoints: 0 }, { minMonthPoints: 1.5 },
    ...(["minAccountValue", "minActiveDays", "minTrades", "minMonthPoints", "finalists"] as const)
      .flatMap((key) => [-1, NaN, Infinity, -Infinity].map((value) => ({ [key]: value }))),
  ];
  invalidConfigs.forEach((config, i) => {
    test(`rejects invalid config ${i}`, () => {
      expect(() => scoreCandidates([], config)).toThrow(Error);
    });
  });

  test("empty universe has zero counts and no ranked candidates", () => {
    const result = scoreCandidates([]);
    expect(result.candidates).toEqual([]);
    expect(result.finalists).toEqual([]);
    expect(result.config).toEqual(DEFAULT_CONFIG);
    expect(result.funnel.map(({ count }) => count)).toEqual(Array(8).fill(0));
    expectFiniteOutput(result);
  });

  test("unknown month remains eligible but unranked and drops out of the eligible funnel", () => {
    const result = scoreCandidates([{ ...rankingInputs[0], month: null, accountValue: NaN }], { allowUnknown: true });
    expect(result.candidates[0].eligible).toBe(true);
    expect(result.candidates[0].metrics).toBeNull();
    expect(result.candidates[0].rank).toBeNull();
    expect(result.funnel.slice(-3)).toEqual([
      { stage: "minMonthPoints", count: 1 }, { stage: "eligible", count: 0 }, { stage: "finalists", count: 0 },
    ]);
    expectFiniteOutput(result);
  });

  test("does not rank histories with no usable return intervals", () => {
    const input: ScoreInput = {
      ...rankingInputs[0],
      accountValue: 20_000,
      tradeCount: 20,
      allTime: {
        accountValueHistory: [[0, 20_000], [31 * 86_400_000, 20_000]],
        pnlHistory: [[0, 0], [31 * 86_400_000, 0]],
      },
      month: {
        accountValueHistory: [[0, 0], [86_400_000, 0]],
        pnlHistory: [[0, 0], [86_400_000, 0]],
      },
    };
    const result = scoreCandidates([input], { minMonthPoints: 2 });
    expect(result.candidates[0].eligible).toBe(true);
    expect(result.candidates[0].metrics?.flags).toContain("no-intervals");
    expect(result.candidates[0].rank).toBeNull();
    expect(result.candidates[0].score).toBeNull();
    expect(result.finalists).toEqual([]);
    expect(result.funnel.at(-2)).toEqual({ stage: "eligible", count: 0 });
  });

  test("preserves supplied passthrough values, including zero and null", () => {
    const passthrough = { avgLeverage: 2, timeInMarket: 0, medianHoldHours: null, makerShare: 0.25 };
    expect(scoreCandidates([{ ...rankingInputs[0], ...passthrough }]).candidates[0].passthrough).toEqual(passthrough);
  });

  test("sorts tied and unranked addresses case-insensitively and preserves their spelling", () => {
    const inputs: ScoreInput[] = [
      { ...rankingInputs[0], address: "b" },
      { ...rankingInputs[0], address: "A" },
      { ...rankingInputs[0], address: "d", closed: true },
      { ...rankingInputs[0], address: "C", closed: true },
    ];
    expect(scoreCandidates(inputs).candidates.map(({ address }) => address)).toEqual(["A", "b", "C", "d"]);
  });
});

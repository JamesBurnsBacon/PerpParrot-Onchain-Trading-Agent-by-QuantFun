import { describe, expect, test } from "bun:test";
import { rankPool } from "../../src/score/score";
import type { Metrics, Percentiles, Ratio } from "../../src/score/types";
import tieNoise from "../fixtures/score/tie-noise.json";
import { expectOutput, seededGenerator, shuffle } from "./helpers";

const WEIGHTS: Record<keyof Percentiles, number> = { sharpe: 1, sortino: 1, calmar: 1, negMaxDrawdown: 1, consistency: 2 };
const terms = Object.keys(WEIGHTS) as (keyof Percentiles)[];

const metricsWith = (values: Partial<Record<keyof Percentiles, Ratio>>): Metrics => ({
  sharpe: values.sharpe ?? null,
  sortino: values.sortino ?? null,
  calmar: values.calmar ?? null,
  maxDrawdown: values.negMaxDrawdown === undefined || values.negMaxDrawdown === null || values.negMaxDrawdown === "+inf"
    ? null : -values.negMaxDrawdown,
  consistency: typeof values.consistency === "number" ? values.consistency : null,
  periodReturn: null, annualisedReturn: null, annualisedVol: null, realizedVol: null, allTimeMaxDrawdown: null,
  lookbackDays: 90, coveredDays: 90, skippedTimeShare: 0, fineTimeShare: 1, flags: [],
});

const valueOf = (metrics: Metrics, term: keyof Percentiles): Ratio =>
  term === "negMaxDrawdown" ? metrics.maxDrawdown === null ? null : -metrics.maxDrawdown : metrics[term];

// Independent oracle: count strictly worse and equal values with "+inf" > numbers > null (SPEC "Ranking").
const level = (value: Ratio): [number, number] => value === null ? [0, 0] : value === "+inf" ? [2, 0] : [1, value];
const worse = (a: Ratio, b: Ratio) => {
  const [la, va] = level(a);
  const [lb, vb] = level(b);
  return la < lb || (la === lb && va < vb);
};
const numeratorByCounting = (values: Ratio[], value: Ratio): number =>
  2 * values.filter((other) => worse(other, value)).length + values.filter((other) => !worse(other, value) && !worse(value, other)).length - 1;

describe("rankPool (SPEC Ranking)", () => {
  test("tie-noise fixture: exact integer order where float sums would disagree", () => {
    const entries = tieNoise.entries as unknown as { address: string; metrics: Metrics }[];
    expectOutput(rankPool(entries), tieNoise.expected);
    for (let seed = 1; seed <= 8; seed++) expectOutput(rankPool(shuffle(entries, seed)), tieNoise.expected);
  });

  for (let count = 2; count <= 8; count++) {
    test(`weighted integer numerators, exact scores and order invariance for N = ${count}`, () => {
      const next = seededGenerator(42 + count);
      const randomValue = (): Ratio => {
        const bucket = (next() >>> 16) % 5;
        return bucket === 0 ? null : bucket === 4 ? "+inf" : (bucket - 1) / 4;
      };
      for (let trial = 0; trial < 32; trial++) {
        const entries = Array.from({ length: count }, (_, index) => ({
          address: String.fromCharCode((index % 2 === 0 ? 65 : 97) + index),
          metrics: metricsWith(Object.fromEntries(terms.map((term) => {
            const value = trial === 0 ? null : randomValue();
            // Drawdown and consistency are plain numbers or null, never "+inf".
            return [term, (term === "negMaxDrawdown" || term === "consistency") && value === "+inf" ? 0 : value];
          }))),
        }));
        const result = rankPool(entries);
        result.forEach((entry, index) => {
          const metrics = entries.find(({ address }) => address === entry.address)!.metrics;
          let numerator = 0;
          for (const term of terms) {
            const k = numeratorByCounting(entries.map((e) => valueOf(e.metrics, term)), valueOf(metrics, term));
            expect(entry.percentiles[term] === k / (2 * (count - 1))).toBe(true);
            numerator += WEIGHTS[term] * k;
          }
          expect(entry.scoreNumerator).toBe(numerator);
          expect(entry.score === numerator / (12 * (count - 1))).toBe(true);
          expect(entry.rank).toBe(index + 1);
          if (index > 0) {
            const previous = result[index - 1];
            expect(previous.scoreNumerator).toBeGreaterThanOrEqual(entry.scoreNumerator);
            if (previous.scoreNumerator === entry.scoreNumerator) {
              const previousSharpe = entries.find(({ address }) => address === previous.address)!.metrics.sharpe;
              expect(worse(previousSharpe, metrics.sharpe)).toBe(false);
              if (!worse(metrics.sharpe, previousSharpe)) {
                expect(previous.address.toLowerCase() < entry.address.toLowerCase()).toBe(true);
              }
            }
          }
        });
        expect(rankPool(shuffle(entries, next()))).toEqual(result);
      }
    });
  }

  test("an exact score tie goes to the higher Sharpe before the address", () => {
    // Swapped Sharpe and Sortino ranks give equal numerators; "b" has the higher Sharpe.
    const result = rankPool([
      { address: "a", metrics: metricsWith({ sharpe: 1, sortino: 2, calmar: 1, negMaxDrawdown: -0.1, consistency: 0.5 }) },
      { address: "b", metrics: metricsWith({ sharpe: 2, sortino: 1, calmar: 1, negMaxDrawdown: -0.1, consistency: 0.5 }) },
    ]);
    expect(result[0].scoreNumerator).toBe(result[1].scoreNumerator);
    expect(result.map(({ address }) => address)).toEqual(["b", "a"]);
  });

  test("+inf ranks above every number and null below", () => {
    const result = rankPool([
      { address: "none", metrics: metricsWith({ sharpe: null }) },
      { address: "num", metrics: metricsWith({ sharpe: 1e300 }) },
      { address: "inf", metrics: metricsWith({ sharpe: "+inf" }) },
    ]);
    const sharpe = Object.fromEntries(result.map(({ address, percentiles }) => [address, percentiles.sharpe]));
    expect(sharpe).toEqual({ none: 0, num: 0.5, inf: 1 });
  });

  test("a single entry has neutral percentiles, score 0.5 and numerator 0", () => {
    expect(rankPool([{ address: "a", metrics: metricsWith({ sharpe: 1 }) }])).toEqual([{
      address: "a",
      percentiles: { sharpe: 0.5, sortino: 0.5, calmar: 0.5, negMaxDrawdown: 0.5, consistency: 0.5 },
      scoreNumerator: 0,
      makerPenalty: 0,
      score: 0.5,
      rank: 1,
    }]);
  });

  test("empty entries produce no ranks", () => {
    expect(rankPool([])).toEqual([]);
  });
});

describe("pure-taker penalty (SPEC Ranking)", () => {
  // Three entries, every term strictly ordered x > y > z: numerators 24, 12, 0 out of 12(N - 1) = 24.
  const pool = (makerShare: Partial<Record<"x" | "y" | "z", number | null>>) =>
    (["x", "y", "z"] as const).map((address, i) => ({
      address,
      makerShare: makerShare[address],
      metrics: metricsWith({ sharpe: 3 - i, sortino: 3 - i, calmar: 3 - i, negMaxDrawdown: -i / 10, consistency: 0.9 - i / 10 }),
    }));
  const config = (pureTakerPenalty: number) => ({ pureTakerMakerShare: 0.05, pureTakerPenalty });
  const view = (ranks: ReturnType<typeof rankPool>) =>
    ranks.map(({ address, scoreNumerator, makerPenalty, rank }) => ({ address, scoreNumerator, makerPenalty, rank }));

  test("takes round(penalty * 12(N - 1)) units off a pure taker; a tie still goes to the higher Sharpe", () => {
    expect(view(rankPool(pool({ x: 0 }), config(0.5)))).toEqual([
      { address: "x", scoreNumerator: 12, makerPenalty: 12, rank: 1 },
      { address: "y", scoreNumerator: 12, makerPenalty: 0, rank: 2 },
      { address: "z", scoreNumerator: 0, makerPenalty: 0, rank: 3 },
    ]);
  });

  test("a large enough penalty reorders the pool; percentiles are unchanged and score uses the net numerator", () => {
    const ranks = rankPool(pool({ x: 0.01 }), config(0.6)); // 0.6 * 24 = 14.4 -> 14
    expect(view(ranks)).toEqual([
      { address: "y", scoreNumerator: 12, makerPenalty: 0, rank: 1 },
      { address: "x", scoreNumerator: 10, makerPenalty: 14, rank: 2 },
      { address: "z", scoreNumerator: 0, makerPenalty: 0, rank: 3 },
    ]);
    const x = ranks.find(({ address }) => address === "x")!;
    expect(x.percentiles).toEqual({ sharpe: 1, sortino: 1, calmar: 1, negMaxDrawdown: 1, consistency: 1 });
    expect(x.score).toBe(10 / 24);
  });

  test("unknown maker share and a share at the threshold are not penalised; the penalty never goes below 0", () => {
    expect(view(rankPool(pool({ x: null, y: 0.05, z: 0 }), config(0.5)))).toEqual([
      { address: "x", scoreNumerator: 24, makerPenalty: 0, rank: 1 },
      { address: "y", scoreNumerator: 12, makerPenalty: 0, rank: 2 },
      { address: "z", scoreNumerator: 0, makerPenalty: 0, rank: 3 },
    ]);
  });

  test("units round half up, and a small pool can round the default penalty to nothing", () => {
    const two = pool({ x: 0 }).slice(0, 2);
    expect(rankPool(two, config(0.125))[0].makerPenalty).toBe(2); // 0.125 * 12 = 1.5 -> 2
    expect(rankPool(two, config(0.02))[0].makerPenalty).toBe(0); // 0.24 -> 0
    expect(rankPool(pool({ x: 0 }))[0].makerPenalty).toBe(0); // default 0.02 * 24 = 0.48 -> 0
  });

  test("a single entry is never penalised", () => {
    expect(rankPool(pool({ x: 0 }).slice(0, 1), config(1))[0]).toMatchObject({ scoreNumerator: 0, makerPenalty: 0, score: 0.5 });
  });
});

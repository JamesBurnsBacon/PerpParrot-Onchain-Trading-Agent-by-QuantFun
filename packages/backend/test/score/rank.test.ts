import { describe, expect, test } from "bun:test";
import { rankByMetrics } from "../../src/score/score";
import type { Metrics } from "../../src/score/types";
import tieNoise from "../fixtures/score/tie-noise.json";

const terms = ["sortino", "calmar", "negMaxDrawdown", "pnlConsistency"] as const;
type Term = typeof terms[number];

const seededGenerator = (initialSeed: number): (() => number) => {
  let seed = initialSeed;
  return () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed;
  };
};

const shuffle = <T>(entries: T[], seed: number): T[] => {
  const result = [...entries];
  const next = seededGenerator(seed);
  for (let i = result.length - 1; i > 0; i--) {
    const j = next() % (i + 1);
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
};

const metricValue = (metrics: Metrics, term: Term): number | null =>
  term === "negMaxDrawdown"
    ? metrics.maxDrawdown === null ? null : -metrics.maxDrawdown
    : metrics[term];

// Independently count worse and equal values for the exact ranking oracle (README §4.2).
const numeratorByCounting = (values: (number | null)[], value: number | null): number => {
  const lower = values.filter((other) => value !== null && (other === null || other < value)).length;
  const equal = values.filter((other) => other === value).length;
  return 2 * lower + equal - 1;
};

describe("rankByMetrics (README §4.2)", () => {
  test("tie-noise fixture uses the address tie-break and bit-identical scores", () => {
    const result = rankByMetrics(tieNoise.entries, tieNoise.finalists);
    expect(result.map(({ address, rank, finalist }) => ({ address, rank, finalist }))).toEqual(
      tieNoise.expected.map(({ address, rank, finalist }) => ({ address, rank, finalist })),
    );
    result.forEach((entry, index) => {
      const expected = tieNoise.expected[index];
      for (const term of terms) {
        expect(Math.abs(entry.percentiles[term] - expected.percentiles[term])).toBeLessThanOrEqual(1e-12);
      }
      expect(Math.abs(entry.score - expected.score)).toBeLessThanOrEqual(1e-12);
      expect(entry.metrics).toEqual(tieNoise.entries.find(({ address }) => address === entry.address)!.metrics);
    });
    const first = result.findIndex(({ address }) => address === "0x00");
    const second = result.findIndex(({ address }) => address === "0x02");
    expect(result[first].score === result[second].score).toBe(true);
    expect(first).toBeLessThan(second);
  });

  for (let count = 2; count <= 8; count++) {
    test(`integer exactness and input order invariance for N = ${count}`, () => {
      const next = seededGenerator(42 + count);
      const randomValue = (): number | null => {
        const bucket = (next() >>> 16) % 4;
        return bucket === 0 ? null : (bucket - 1) / 4;
      };
      for (let trial = 0; trial < 32; trial++) {
        const entries = Array.from({ length: count }, (_, index) => ({
          address: String.fromCharCode((index % 2 === 0 ? 65 : 97) + index),
          metrics: {
            sortino: trial === 0 ? null : randomValue(),
            calmar: trial === 0 ? null : randomValue(),
            maxDrawdown: trial === 0 ? null : randomValue(),
            pnlConsistency: trial === 0 ? null : randomValue(),
            realizedVol: randomValue(),
            flags: [],
          } satisfies Metrics,
        }));
        const result = rankByMetrics(entries, count - 1);
        const scoresByNumerator = new Map<number, number>();
        result.forEach((entry, index) => {
          let sum = 0;
          for (const term of terms) {
            const numerator = numeratorByCounting(
              entries.map(({ metrics }) => metricValue(metrics, term)),
              metricValue(entry.metrics, term),
            );
            expect(entry.percentiles[term] === numerator / (2 * (count - 1))).toBe(true);
            sum += numerator;
          }
          expect(entry.score === sum / (8 * (count - 1))).toBe(true);
          if (scoresByNumerator.has(sum)) {
            expect(entry.score === scoresByNumerator.get(sum)).toBe(true);
          }
          scoresByNumerator.set(sum, entry.score);
          expect(entry.rank).toBe(index + 1);
          if (index > 0) {
            const previous = result[index - 1];
            expect(previous.score).toBeGreaterThanOrEqual(entry.score);
            if (previous.score === entry.score) {
              expect(previous.address.toLowerCase() < entry.address.toLowerCase()).toBe(true);
            }
          }
        });
        expect(rankByMetrics(shuffle(entries, next()), count - 1)).toEqual(result);
      }
    });
  }

  test("a single entry has neutral percentiles and score", () => {
    expect(rankByMetrics(tieNoise.entries.slice(0, 1), 1)).toEqual([{
      ...tieNoise.entries[0],
      percentiles: { sortino: 0.5, calmar: 0.5, negMaxDrawdown: 0.5, pnlConsistency: 0.5 },
      score: 0.5,
      rank: 1,
      finalist: true,
    }]);
  });

  test("finalists are exactly the first entries up to the cap", () => {
    const result = rankByMetrics(tieNoise.entries, 2);
    expect(result.filter(({ finalist }) => finalist)).toEqual(result.slice(0, 2));
    expect(result.map(({ finalist }) => finalist)).toEqual([true, true, false, false]);
  });

  test("shuffling the tie-noise entries preserves the complete output", () => {
    const result = rankByMetrics(tieNoise.entries, tieNoise.finalists);
    for (let seed = 1; seed <= 8; seed++) {
      expect(rankByMetrics(shuffle(tieNoise.entries, seed), tieNoise.finalists)).toEqual(result);
    }
  });

  test("empty entries produce no ranks or finalists", () => {
    expect(rankByMetrics([], 3)).toEqual([]);
  });
});

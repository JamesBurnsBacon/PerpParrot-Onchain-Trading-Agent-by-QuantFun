import { describe, expect, test } from "bun:test";
import { computeMetrics, validateSeries, type Metrics, type TimePoint, type WindowHistory } from "../../src/score";
import cases from "../fixtures/score/metrics-cases.json";

const expectFiniteMetrics = (metrics: Metrics): void => {
  for (const value of Object.values(metrics)) {
    if (!Array.isArray(value) && value !== null) expect(Number.isFinite(value)).toBe(true);
  }
};

describe("computeMetrics", () => {
  for (const fixture of cases) {
    test(fixture.name, () => {
      const month: WindowHistory = {
        accountValueHistory: fixture.month.accountValueHistory.map(([ts, value]): TimePoint => [ts, value]),
        pnlHistory: fixture.month.pnlHistory.map(([ts, value]): TimePoint => [ts, value]),
      };
      const actual = computeMetrics(month);
      for (const key of Object.keys(fixture.expected) as (keyof Metrics)[]) {
        const expected = fixture.expected[key];
        const value = actual[key];
        if (typeof expected === "number") {
          expect(typeof value).toBe("number");
          if (typeof value !== "number") throw new Error(`non-numeric ${key}`);
          expect(Math.abs(value - expected)).toBeLessThanOrEqual(1e-9);
        } else if (expected === null) {
          expect(value).toBeNull();
        } else {
          expect(value).toEqual(expected);
        }
      }
      expectFiniteMetrics(actual);
    });
  }

  test("never exposes non-finite arithmetic results (README §4.2)", () => {
    for (const equity of [Number.MIN_VALUE, 1, Number.MAX_VALUE]) {
      expectFiniteMetrics(computeMetrics({
        accountValueHistory: [[0, equity], [86_400_000, equity], [172_800_000, equity]],
        pnlHistory: [[0, -Number.MAX_VALUE], [86_400_000, Number.MAX_VALUE], [172_800_000, 0]],
      }));
    }
  });

  test("returns null metrics for zero elapsed time", () => {
    expect(computeMetrics({ accountValueHistory: [[0, 100], [0, 100]], pnlHistory: [[0, 0], [0, 10]] })).toEqual({
      sortino: null, calmar: null, maxDrawdown: null, pnlConsistency: null, realizedVol: null, flags: ["no-intervals"],
    });
  });

  test("skips negative equity and reports repeated skipped intervals once", () => {
    expect(computeMetrics({
      accountValueHistory: [[0, -100], [86_400_000, 0], [172_800_000, 100]],
      pnlHistory: [[0, 0], [86_400_000, 10], [172_800_000, 20]],
    })).toEqual({
      sortino: null, calmar: null, maxDrawdown: null, pnlConsistency: null, realizedVol: null,
      flags: ["zero-equity-interval", "no-intervals"],
    });
  });
});

describe("validateSeries", () => {
  const valid: WindowHistory = {
    accountValueHistory: [[0, 1000], [86_400_000, 1010]],
    pnlHistory: [[0, 0], [86_400_000, 10]],
  };

  test("accepts a valid series", () => {
    expect(validateSeries(valid)).toBe(true);
  });

  const invalid: { name: string; window: WindowHistory | null }[] = [
    { name: "null", window: null },
    { name: "different lengths", window: { ...valid, pnlHistory: [[0, 0]] } },
    { name: "different timestamps", window: { ...valid, pnlHistory: [[0, 0], [86_400_001, 10]] } },
    { name: "repeated timestamps", window: { accountValueHistory: [[0, 1], [0, 2]], pnlHistory: [[0, 0], [0, 1]] } },
    { name: "decreasing timestamps", window: { accountValueHistory: [[1, 1], [0, 2]], pnlHistory: [[1, 0], [0, 1]] } },
    { name: "one point", window: { accountValueHistory: [[0, 1]], pnlHistory: [[0, 0]] } },
    { name: "no points", window: { accountValueHistory: [], pnlHistory: [] } },
  ];
  for (const { name, window } of invalid) {
    test(`rejects ${name}`, () => {
      expect(validateSeries(window)).toBe(false);
    });
  }
});

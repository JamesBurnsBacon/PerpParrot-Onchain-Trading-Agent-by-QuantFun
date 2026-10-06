import { describe, expect, test } from "bun:test";
import {
  computeFilters,
  DEFAULT_CONFIG,
  isEligible,
  scoreCandidates,
  type FilterName,
  type FilterStatus,
  type ScoreInput,
  type TimePoint,
} from "../../src/score";
import cases from "../fixtures/score/edge-cases.json";

describe("score filters (README §4.2)", () => {
  for (const fixture of cases) {
    const raw = fixture.input;
    if (raw.kind !== "trader" && raw.kind !== "hypercore-vault" && raw.kind !== "erc4626-vault") {
      throw new Error(`invalid fixture kind: ${raw.kind}`);
    }
    if (typeof raw.accountValue === "string" && raw.accountValue !== "NaN") {
      throw new Error(`invalid fixture accountValue: ${raw.accountValue}`);
    }
    const input: ScoreInput = {
      ...raw,
      kind: raw.kind,
      accountValue: raw.accountValue === "NaN" ? NaN : raw.accountValue,
      month: raw.month === null ? null : {
        accountValueHistory: raw.month.accountValueHistory.map(([ts, value]): TimePoint => [ts, value]),
        pnlHistory: raw.month.pnlHistory.map(([ts, value]): TimePoint => [ts, value]),
      },
      allTime: raw.allTime === null ? null : {
        accountValueHistory: raw.allTime.accountValueHistory.map(([ts, value]): TimePoint => [ts, value]),
        pnlHistory: raw.allTime.pnlHistory.map(([ts, value]): TimePoint => [ts, value]),
      },
    };

    for (const allowUnknown of [false, true]) {
      test(`${fixture.name}, allowUnknown=${allowUnknown}`, () => {
        const result = allowUnknown ? scoreCandidates([input], { allowUnknown: true }) : scoreCandidates([input]);
        const candidate = result.candidates[0];
        const expected = fixture.expected;
        expect(expected.filters).toEqual(candidate.filters);
        expect(candidate.eligible).toBe(allowUnknown ? expected.eligibleWithAllowUnknown : expected.eligible);
        expect(candidate.metrics === null).toBe(expected.metricsIsNull);
        expect(candidate.rank).toBe(allowUnknown ? expected.rankWithAllowUnknown : expected.rank);
        const config = { ...DEFAULT_CONFIG, allowUnknown };
        expect(expected.filters).toEqual(computeFilters(input, config));
        expect(isEligible(expected.filters as Record<FilterName, FilterStatus>, config)).toBe(
          allowUnknown ? expected.eligibleWithAllowUnknown : expected.eligible,
        );
        if (candidate.rank === null) {
          expect(candidate.percentiles).toBeNull();
          expect(candidate.score).toBeNull();
          expect(candidate.finalist).toBe(false);
        }
      });
    }
  }

  test("invalid trade counts fail closed even when unknowns are allowed", () => {
    const base = {
      address: "addr-invalid-trades",
      kind: "trader" as const,
      accountValue: 20_000,
      closed: false,
      month: { accountValueHistory: [[0, 100], [86_400_000, 101]] as TimePoint[], pnlHistory: [[0, 0], [86_400_000, 1]] as TimePoint[] },
      allTime: { accountValueHistory: [[0, 100], [31 * 86_400_000, 101]] as TimePoint[], pnlHistory: [[0, 0], [31 * 86_400_000, 1]] as TimePoint[] },
    };
    for (const tradeCount of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      const result = scoreCandidates([{ ...base, tradeCount }], { allowUnknown: true, minMonthPoints: 2 });
      expect(result.candidates[0].filters.minTrades).toBe("fail");
      expect(result.candidates[0].eligible).toBe(false);
      expect(result.finalists).toEqual([]);
    }
  });
});

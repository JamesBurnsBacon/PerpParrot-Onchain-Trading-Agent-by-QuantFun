import { describe, expect, test } from "bun:test";
import {
  computeFilters,
  computeMetrics,
  DEFAULT_CONFIG,
  isEligible,
  scoreCandidates,
  type FilterName,
  type FilterStatus,
} from "../../src/score";
import cases from "../fixtures/score/edge-cases.json";
import { toInput, type RawInput } from "./helpers";

const ALL_FILTERS: FilterName[] = [
  "minAccountValue", "minActiveDays", "stillActive", "minTrades", "notClosed", "minMonthPoints", "minCoverage", "noRuin",
];

type EdgeCase = {
  name: string;
  input: RawInput;
  expected: {
    filters: Record<FilterName, FilterStatus>;
    eligible: boolean;
    metricsIsNull: boolean;
    rank: number | null;
    eligibleWithAllowUnknown: boolean;
    rankWithAllowUnknown: number | null;
  };
};

describe("score filters (SPEC Filters, Eligibility)", () => {
  for (const fixture of cases as unknown as EdgeCase[]) {
    const input = toInput(fixture.input);
    for (const allowUnknown of [[], ALL_FILTERS]) {
      test(`${fixture.name}, allowUnknown=${allowUnknown.length > 0 ? "all" : "none"}`, () => {
        const candidate = scoreCandidates([input], { allowUnknown }).candidates[0];
        const { expected } = fixture;
        const relaxed = allowUnknown.length > 0;
        expect(candidate.filters).toEqual(expected.filters);
        expect(candidate.eligible).toBe(relaxed ? expected.eligibleWithAllowUnknown : expected.eligible);
        expect(candidate.metrics === null).toBe(expected.metricsIsNull);
        expect(candidate.rank).toBe(relaxed ? expected.rankWithAllowUnknown : expected.rank);
        const config = { ...DEFAULT_CONFIG, allowUnknown };
        expect(computeFilters(input, computeMetrics(input, config), config)).toEqual(expected.filters);
        expect(isEligible(expected.filters, config)).toBe(relaxed ? expected.eligibleWithAllowUnknown : expected.eligible);
        if (candidate.rank === null) {
          expect(candidate.percentiles).toBeNull();
          expect(candidate.score).toBeNull();
          expect(candidate.finalist).toBe(false);
        }
      });
    }
  }

  test("allowUnknown relaxes only the listed filters, never a fail", () => {
    const statuses = Object.fromEntries(ALL_FILTERS.map((name) => [name, "pass"])) as Record<FilterName, FilterStatus>;
    const withUnknownTrades = { ...statuses, minTrades: "unknown" as const };
    expect(isEligible(withUnknownTrades, DEFAULT_CONFIG)).toBe(false);
    expect(isEligible(withUnknownTrades, { ...DEFAULT_CONFIG, allowUnknown: ["minTrades"] })).toBe(true);
    expect(isEligible(withUnknownTrades, { ...DEFAULT_CONFIG, allowUnknown: ["notClosed"] })).toBe(false);
    expect(isEligible({ ...statuses, minTrades: "fail" }, { ...DEFAULT_CONFIG, allowUnknown: ALL_FILTERS })).toBe(false);
  });
});

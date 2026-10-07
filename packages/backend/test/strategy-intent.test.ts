import { describe, expect, test } from "bun:test";
import configuration from "../fixtures/frozen-configuration.json" with { type: "json" };
import type { Policy } from "../../shared/src/contracts";
import { validateRuntimePolicy } from "../../shared/src/policy-runtime";
import { mapScoreFinalists, shortlistScoreFinalists } from "../src/strategy-intent-adapter";
import type { Candidate } from "../src/score/types";
import {
  STRATEGY_INTENT_JSON_SCHEMA,
  checkStrategyIntent,
  intentToPreview,
  parseStrategyIntent,
  shortlist,
  type StrategyIntent,
} from "../../shared/strategy-intent";

const base = configuration.policy as Policy;
const valid: StrategyIntent = {
  riskStyle: "aggressive", maxSources: 5, diversification: "low", leverageComfort: "high",
  requestedLeverage: null, avoidClones: false, horizon: "short", clarify: null, reply: "Build a diversified paper portfolio.",
};
const address = (index: number) => `0x${index.toString(16).padStart(40, "0")}`;
const finalist = (index: number, changes: Record<string, unknown> = {}) => ({
  address: address(index), kind: "TRADER", score: index / 100, flags: [], maxDrawdown: index / 1000,
  realizedVol: index / 10, cloneOf: false, ...changes,
});

describe("strategy intent contract", () => {
  test("schema and parser only allow bounded preferences, never policy controls", () => {
    expect(checkStrategyIntent(valid)).toEqual([]);
    expect(parseStrategyIntent(valid)).toEqual(valid);
    expect(Object.keys(STRATEGY_INTENT_JSON_SCHEMA.schema.properties)).toEqual(Object.keys(valid));
    expect(STRATEGY_INTENT_JSON_SCHEMA.schema.additionalProperties).toBe(false);
    for (const forbidden of ["address", "weight", "cashBuffer", "mode", "policy"]) {
      expect(STRATEGY_INTENT_JSON_SCHEMA.schema.properties).not.toHaveProperty(forbidden);
    }
  });

  test("rejects missing, extra, accessor, malformed, hidden, and bidi input", () => {
    expect(checkStrategyIntent({ ...valid, address: address(9) }).some((problem) => problem.includes("unexpected key"))).toBe(true);
    const missing = { ...valid } as Record<string, unknown>;
    delete missing.maxSources;
    expect(checkStrategyIntent(missing).some((problem) => problem.includes("missing key: maxSources"))).toBe(true);
    const accessor = { ...valid };
    Object.defineProperty(accessor, "reply", { get: () => "later value", enumerable: true });
    expect(checkStrategyIntent(accessor).some((problem) => problem.includes("accessor"))).toBe(true);
    expect(checkStrategyIntent({ ...valid, maxSources: 4 })).not.toEqual([]);
    expect(checkStrategyIntent({ ...valid, reply: "ok\u202etest" }).some((problem) => problem.includes("bidirectional"))).toBe(true);
    expect(checkStrategyIntent({ ...valid, clarify: "invisible\u200btext" }).some((problem) => problem.includes("hidden"))).toBe(true);
  });

  test("snapshots once and rejects proxies that cannot be safely inspected", () => {
    let reads = 0;
    const changing = new Proxy({ ...valid }, { get(target, key, receiver) {
      if (key === "reply") return ++reads === 1 ? target.reply : "changed after validation";
      return Reflect.get(target, key, receiver);
    } });
    const parsed = parseStrategyIntent(changing);
    expect(parsed.reply).toBe(valid.reply);
    expect(reads).toBe(0);
    const hostile = new Proxy({ ...valid }, { ownKeys() { throw new Error("trap"); } });
    expect(checkStrategyIntent(hostile)).not.toEqual([]);
    const revoked = Proxy.revocable({}, {}); revoked.revoke();
    expect(checkStrategyIntent(revoked.proxy)).not.toEqual([]);
  });

  test("returns immutable validated snapshots", () => {
    const input = { ...valid };
    const parsed = parseStrategyIntent(input);
    input.reply = "mutated";
    expect(parsed.reply).toBe(valid.reply);
    expect(Object.isFrozen(parsed)).toBe(true);
  });
});

describe("simulation preview compiler", () => {
  test("only tightens risk ceilings and can never emit LIVE", () => {
    const result = intentToPreview({ ...valid, maxSources: 6, riskStyle: "conservative", diversification: "high", leverageComfort: "low", requestedLeverage: 100 }, base);
    validateRuntimePolicy(result.policy);
    expect(result.policy.mode).toBe("SIMULATION");
    expect(result.executionMode).toBe("SIMULATION_PREVIEW");
    expect(result.approvalRequired).toBe(true);
    expect(result.policy.maxSourceWeight).toBeLessThanOrEqual(base.maxSourceWeight);
    expect(result.policy.maxGrossLeverage).toBeLessThanOrEqual(base.maxGrossLeverage);
    expect(result.policy.cashBuffer).toBeGreaterThanOrEqual(base.cashBuffer);
    expect(result.policy.maxPairCorrelation).toBeLessThanOrEqual(base.maxPairCorrelation);
    expect(result.policy.maxExposureOverlap).toBeLessThanOrEqual(base.maxExposureOverlap);
  });

  test("clamps a visitor's leverage request to the stricter policy cap", () => {
    const result = intentToPreview({ ...valid, requestedLeverage: 1000 }, base);
    expect(result.policy.maxGrossLeverage).toBeLessThanOrEqual(base.maxGrossLeverage);
    expect(result.clamps).toEqual([{ field: "maxGrossLeverage", requested: 1000, applied: base.maxGrossLeverage }]);
  });

  test("does not compile or shortlist while the model is asking a clarification question", () => {
    const question = { ...valid, clarify: "How much loss can you tolerate?" };
    expect(() => intentToPreview(question, base)).toThrow(/needs clarification/);
    expect(() => shortlist([], question, 5)).toThrow(/needs clarification/);
  });

  test("enforces visitor source maximum rather than silently raising it", () => {
    const tight = { ...base, maxSourceWeight: 0.1, cashBuffer: 0.4 };
    expect(() => intentToPreview({ ...valid, maxSources: 5 }, tight)).toThrow(/require 6 sources/);
    expect(intentToPreview({ ...valid, maxSources: 6 }, tight).requiredSources).toBe(6);
  });

  test("uses exact decimal feasibility at an integer boundary", () => {
    const exact = { ...base, maxSourceWeight: 0.1, cashBuffer: 0.4 };
    expect(() => intentToPreview({ ...valid, maxSources: 5 }, exact)).toThrow(/require 6 sources/);
  });

  test("exhaustively preserves risk monotonicity across preference combinations", () => {
    const bases = [base, { ...base, maxSourceWeight: 0.12, cashBuffer: 0.35, maxGrossLeverage: 1 }, { ...base, maxPairCorrelation: 0.55, maxExposureOverlap: 0.3 }];
    const leverageRequests = [null, 0.5, 1, 2, 1000];
    for (const policyBase of bases) for (const riskStyle of ["aggressive", "balanced", "conservative"] as const)
      for (const diversification of ["low", "medium", "high"] as const)
        for (const leverageComfort of ["low", "medium", "high"] as const)
          for (const requestedLeverage of leverageRequests) {
            const result = intentToPreview({ ...valid, maxSources: 15, riskStyle, diversification, leverageComfort, requestedLeverage }, policyBase);
            expect(result.policy.mode).toBe("SIMULATION");
            expect(result.policy.maxSourceWeight).toBeLessThanOrEqual(policyBase.maxSourceWeight);
            expect(result.policy.maxGrossLeverage).toBeLessThanOrEqual(policyBase.maxGrossLeverage);
            expect(result.policy.cashBuffer).toBeGreaterThanOrEqual(policyBase.cashBuffer);
            expect(result.policy.maxPairCorrelation).toBeLessThanOrEqual(policyBase.maxPairCorrelation);
            expect(result.policy.maxExposureOverlap).toBeLessThanOrEqual(policyBase.maxExposureOverlap);
            if (requestedLeverage !== null) expect(result.policy.maxGrossLeverage).toBeLessThanOrEqual(requestedLeverage);
          }
  });

  test("rejects malformed policies and never elevates a restrictive base bucket", () => {
    expect(() => intentToPreview(valid, { ...base, mode: "ACTIVE" })).toThrow(/invalid base policy/);
    const result = intentToPreview({ ...valid, riskStyle: "aggressive" }, { ...base, bucket: "CONSERVATIVE" });
    expect(result.policy.bucket).toBe("CONSERVATIVE");
    expect(result.policy.mode).toBe("SIMULATION");
  });

  test("reads base values from own data descriptors and rejects accessor policy fields", () => {
    let reads = 0;
    const hostile = { ...base, get cashBuffer() { reads++; return base.cashBuffer; } };
    expect(() => intentToPreview(valid, hostile)).toThrow(/accessor/);
    expect(reads).toBe(0);
  });
});

describe("deterministic finalist shortlist", () => {
  const candidates = Array.from({ length: 16 }, (_, index) => finalist(index + 1));

  test("is deterministic under input permutation and returns only finalist addresses", () => {
    const a = shortlist(candidates, valid, 5);
    const b = shortlist([...candidates].reverse(), valid, 5);
    expect(a).toEqual(b);
    expect(a).toEqual(candidates.slice(-5).reverse().map((row) => row.address));
  });

  test("drops malformed, excluded, unscored, and optionally cloned candidates", () => {
    const rows = [
      finalist(1, { flags: ["ruin"] }), finalist(2, { score: null }), finalist(3, { address: "not-an-address" }),
      finalist(4, { cloneOf: true }), finalist(5, { score: 0.95 }), finalist(6), finalist(7), finalist(8), finalist(9), finalist(10),
    ];
    const withoutClones = shortlist(rows, { ...valid, avoidClones: true }, 5);
    expect(withoutClones).not.toContain(address(4));
    expect(withoutClones).toContain(address(5));
    expect(withoutClones).not.toContain(address(1));
    expect(withoutClones).not.toContain(address(2));
    expect(withoutClones).not.toContain("not-an-address");
  });

  test("collapses case-variant duplicate addresses before limiting the result", () => {
    const duplicate = { ...finalist(1), address: address(2).toUpperCase().replace("0X", "0x"), score: 0.99 };
    const rows = [finalist(2), duplicate, ...candidates.slice(2, 10)];
    const result = shortlist(rows, valid, 5);
    expect(result.filter((entry) => entry.toLowerCase() === address(2))).toHaveLength(1);
  });

  test("safe styles choose lower risk within a bounded high-score window", () => {
    const rows = Array.from({ length: 12 }, (_, index) => finalist(index + 1));
    const balanced = shortlist(rows, { ...valid, riskStyle: "balanced" }, 5);
    expect(balanced).toHaveLength(5);
    expect(balanced).toEqual([...rows.slice(-10)].reverse().sort((a, b) => a.maxDrawdown - b.maxDrawdown).slice(0, 5).map((row) => row.address));
  });

  test("rejects out-of-bound limits and non-array input", () => {
    expect(() => shortlist(candidates, valid, 4)).toThrow(RangeError);
    expect(() => shortlist(candidates, valid, 6)).toThrow(RangeError);
    expect(() => shortlist({}, valid, 5)).toThrow(TypeError);
  });
});

describe("integration with the actual Score output", () => {
  const scoreCandidate = (index: number, overrides: Partial<Candidate> = {}): Candidate => ({
    address: address(index), kind: "trader",
    pool: "trader", activeDays: 90,
    filters: { minAccountValue: "pass", minActiveDays: "pass", stillActive: "pass", minTrades: "pass", notClosed: "pass", minMonthPoints: "pass", minCoverage: "pass", noRuin: "pass" },
    eligible: true,
    metrics: { sharpe: 1, sortino: 1, calmar: 0.5, maxDrawdown: index / 100, consistency: 0.6, periodReturn: 0.2, annualisedReturn: 0.2, annualisedVol: index / 10, realizedVol: index / 10, allTimeMaxDrawdown: index / 100, lookbackDays: 90, coveredDays: 90, skippedTimeShare: 0, fineTimeShare: 1, flags: [] },
    percentiles: { sharpe: 0.8, sortino: 0.8, calmar: 0.7, negMaxDrawdown: 0.6, consistency: 0.5 },
    scoreNumerator: index, makerPenalty: 0, cloneOf: null, clones: [], score: index / 100, rank: index, finalist: true,
    passthrough: { avgLeverage: 1, timeInMarket: 0.5, medianHoldHours: 2, makerShare: 0.2 },
    ...overrides,
  });

  test("maps Score's native realizedVol and flags without fabricating clone status", () => {
    const mapped = mapScoreFinalists([scoreCandidate(1), scoreCandidate(2, { finalist: false }), scoreCandidate(3, { metrics: null })]);
    expect(mapped).toHaveLength(1);
    expect(mapped[0]).toEqual({
      address: address(1), kind: "trader", score: 0.01, flags: [], maxDrawdown: 0.01,
      realizedVol: 0.1, cloneOf: null,
    });
  });

  test("fail-closed clone preference keeps only finalists with verified non-clone status", () => {
    const candidates = Array.from({ length: 7 }, (_, index) => scoreCandidate(index + 1));
    const evidence = new Map(candidates.slice(0, 6).map((candidate) => [candidate.address.toUpperCase(), false]));
    evidence.set(address(1).toUpperCase(), true);
    const mapped = mapScoreFinalists(candidates, evidence);
    expect(mapped.find((row) => row.address === address(7))?.cloneOf).toBeNull();
    const selected = shortlistScoreFinalists(candidates, { ...valid, avoidClones: true }, 5, evidence);
    expect(selected).toHaveLength(5);
    expect(selected).not.toContain(address(1));
    expect(selected).not.toContain(address(7));
  });
});

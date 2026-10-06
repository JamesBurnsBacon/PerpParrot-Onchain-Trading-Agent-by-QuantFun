import { describe, expect, test } from "bun:test";
import configuration from "../fixtures/frozen-configuration.json";
import type { Policy } from "../../shared/src/contracts";
import { validateRuntimePolicy } from "../../shared/src/policy-runtime";
import {
  STRATEGY_INTENT_JSON_SCHEMA,
  checkStrategyIntent,
  parseStrategyIntent,
  intentToPolicy,
  shortlist,
  type StrategyIntent,
  type RiskStyle,
  type Level,
  type FinalistLike,
} from "../../shared/strategy-intent";

validateRuntimePolicy(configuration.policy);
const base: Policy = configuration.policy;
const valid: StrategyIntent = {
  riskStyle: "aggressive",
  maxSources: 5,
  diversification: "low",
  leverageComfort: "high",
  requestedLeverage: null,
  avoidClones: false,
  horizon: "short",
  clarify: null,
  reply: "Let's build a book.",
};

// All successful mapper calls, including repeated calls, go through runtime validation.
const map = (intent: StrategyIntent, policy: Policy = base) => {
  const result = intentToPolicy(intent, policy);
  validateRuntimePolicy(result.policy);
  return result;
};

const changeOrder = [
  "bucket", "mode", "maxSourceWeight", "maxGrossLeverage", "cashBuffer",
  "maxPairCorrelation", "maxExposureOverlap",
] as const;

const random = (seed: number) => () => {
  seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
  return seed / 4294967296;
};

describe("strategy intent validation", () => {
  test("accepts valid values and inclusive boundaries", () => {
    for (const intent of [
      valid,
      { ...valid, maxSources: 25, requestedLeverage: 1000, clarify: "?".repeat(200), reply: "x".repeat(400) },
      { ...valid, requestedLeverage: Number.MIN_VALUE, clarify: "", reply: "鳥" },
      Object.assign(Object.create(null), valid),
    ]) {
      expect(checkStrategyIntent(intent)).toEqual([]);
      expect(parseStrategyIntent(intent)).toEqual(intent);
    }
  });

  test.each([null, undefined, [], "intent", 7, true, new Date(0), Object.create(valid)].map((value) => [value]))(
    "rejects non-plain objects: %p", (value) => {
      expect(checkStrategyIntent(value).join(" ")).toContain("plain object");
    },
  );

  for (const key of Object.keys(valid)) {
    test(`reports missing ${key}`, () => {
      const value: Record<string, unknown> = { ...valid };
      delete value[key];
      expect(checkStrategyIntent(value).some((problem) => problem.includes(key))).toBe(true);
    });
  }

  test("reports every extra key, including non-enumerable and symbol keys", () => {
    const value = { ...valid, weights: [], address: "0x123" };
    Object.defineProperty(value, "hidden", { value: 1 });
    Object.defineProperty(value, Symbol("secret"), { value: 1 });
    const problems = checkStrategyIntent(value);
    for (const key of ["weights", "address", "hidden", "secret"]) {
      expect(problems.some((problem) => problem.includes(key))).toBe(true);
    }
  });

  const invalid: [keyof StrategyIntent, unknown][] = [
    ["riskStyle", "AGGRESSIVE"], ["riskStyle", null],
    ["diversification", "medium"], ["leverageComfort", "medium"],
    ...[4, 26, 5.5, "7", NaN, Infinity, Number.MAX_SAFE_INTEGER + 1].map(
      (value): [keyof StrategyIntent, unknown] => ["maxSources", value],
    ),
    ...[0, -1, NaN, Infinity, -Infinity, 1001, "3", undefined].map(
      (value): [keyof StrategyIntent, unknown] => ["requestedLeverage", value],
    ),
    ["avoidClones", 1], ["avoidClones", "false"], ["horizon", "long"],
    ["clarify", "?".repeat(201)], ["clarify", 1],
    ["reply", ""], ["reply", "x".repeat(401)], ["reply", null], ["reply", 1],
  ];
  test.each(invalid)("rejects %s = %p", (key, value) => {
    expect(checkStrategyIntent({ ...valid, [key]: value }).some((problem) => problem.includes(key))).toBe(true);
  });

  test("rejects all ASCII controls in either text field", () => {
    for (const code of [...Array.from({ length: 32 }, (_, i) => i), 127]) {
      for (const field of ["clarify", "reply"]) {
        expect(checkStrategyIntent({ ...valid, [field]: `a${String.fromCharCode(code)}b` })
          .some((problem) => problem.includes(field) && problem.includes("control"))).toBe(true);
      }
    }
  });

  test("collects independent violations and parse uses the first problem", () => {
    const value = { ...valid, maxSources: 4, reply: "", extra: true };
    const problems = checkStrategyIntent(value);
    expect(problems).toHaveLength(3);
    expect(() => parseStrategyIntent(value)).toThrow(`invalid strategy intent: ${problems[0]}`);
  });

  test("never throws on throwing getters or revoked proxies", () => {
    const value = { ...valid, get reply(): string { throw new Error("untrusted getter"); } };
    const proxy = Proxy.revocable({}, {});
    proxy.revoke();
    for (const input of [value, proxy.proxy]) {
      expect(() => checkStrategyIntent(input)).not.toThrow();
      expect(checkStrategyIntent(input).length).toBeGreaterThan(0);
    }
  });

  test("schema and type have exactly the same keys and constraints", () => {
    // Record makes adding or removing a type key a compile-time failure here.
    const keys: Record<keyof StrategyIntent, true> = {
      riskStyle: true, maxSources: true, diversification: true, leverageComfort: true,
      requestedLeverage: true, avoidClones: true, horizon: true, clarify: true, reply: true,
    };
    const { name, strict, schema } = STRATEGY_INTENT_JSON_SCHEMA;
    expect(name).toBe("strategy_intent");
    expect(strict).toBe(true);
    expect(schema.type).toBe("object");
    expect(schema.additionalProperties).toBe(false);
    const required: string[] = [...schema.required];
    expect(required.sort()).toEqual(Object.keys(schema.properties).sort());
    expect(required.sort()).toEqual(Object.keys(keys).sort());
    expect(schema.properties).toEqual({
      riskStyle: { type: "string", enum: ["aggressive", "balanced", "conservative"] },
      maxSources: { type: "integer", minimum: 5, maximum: 25 },
      diversification: { type: "string", enum: ["low", "med", "high"] },
      leverageComfort: { type: "string", enum: ["low", "med", "high"] },
      requestedLeverage: { type: ["number", "null"], exclusiveMinimum: 0, maximum: 1000 },
      avoidClones: { type: "boolean" },
      horizon: { type: "string", enum: ["short", "medium"] },
      clarify: { type: ["string", "null"], maxLength: 200 },
      reply: { type: "string", minLength: 1, maxLength: 400 },
    });
  });
});

describe("intent to bounded policy", () => {
  // Literal expectations from the specification, independent of implementation tables.
  const styles: [RiskStyle, Policy["bucket"], Policy["mode"], number, number, [number, number, number]][] = [
    ["aggressive", "AGGRESSIVE", "LIVE", 0.30, 0.10, [1.5, 2.5, 3]],
    ["balanced", "BALANCED", "SIMULATION", 0.20, 0.20, [1.5, 2, 2]],
    ["conservative", "CONSERVATIVE", "SIMULATION", 0.12, 0.35, [1, 1, 1]],
  ];
  const diversificationCases: [Level, number, number][] = [
    ["low", 0.80, 0.50], ["med", 0.70, 0.40], ["high", 0.55, 0.30],
  ];
  const levels: Level[] = ["low", "med", "high"];
  for (const [riskStyle, bucket, mode, weight, cash, leverages] of styles) {
    for (const [diversification, corr, overlap] of diversificationCases) {
      levels.forEach((leverageComfort, index) => {
        test(`golden ${riskStyle}/${diversification}/${leverageComfort}`, () => {
          const before = structuredClone(base);
          const result = map({ ...valid, riskStyle, diversification, leverageComfort });
          const expected: Policy = {
            ...base, bucket, mode, maxSourceWeight: weight, cashBuffer: cash,
            maxGrossLeverage: leverages[index], maxPairCorrelation: corr, maxExposureOverlap: overlap,
          };
          expect(result.policy).toEqual(expected);
          expect(result.policy).not.toBe(base);
          expect(base).toEqual(before);
          expect(result.changes).toEqual(changeOrder.filter((field) => expected[field] !== base[field])
            .map((field) => ({ field, from: base[field], to: expected[field] })));
          expect(result.clamps).toEqual([]);
          expect(result.effectiveMaxSources).toBe(riskStyle === "conservative" ? 6 : 5);
          expect(result.liveEligible).toBe(riskStyle === "aggressive");
          if (riskStyle !== "aggressive") {
            expect(result.notes).toContain(`${riskStyle} runs as a paper book: live is Aggressive-only`);
          } else {
            expect(result.notes).toEqual([]);
          }
        });
      });
    }
  }

  test.each([
    [100, 3, [{ field: "maxGrossLeverage", requested: 100, applied: 3 }]],
    [1, 1, []], [3, 3, []],
  ] as const)("explicit leverage %p", (requestedLeverage, applied, clamps) => {
    const result = map({ ...valid, requestedLeverage });
    expect(result.policy.maxGrossLeverage).toBe(applied);
    expect(result.clamps).toEqual([...clamps]);
  });

  test("clamps after risk style, comfort and base tightening", () => {
    const result = map({ ...valid, riskStyle: "balanced", leverageComfort: "low", requestedLeverage: 100 });
    expect(result.policy.maxGrossLeverage).toBe(1.5);
    expect(result.clamps).toEqual([{ field: "maxGrossLeverage", requested: 100, applied: 1.5 }]);
  });

  test("aggressive preserves the base bucket/mode and cannot grant live eligibility", () => {
    for (const policy of [
      { ...base, bucket: "BALANCED" as const },
      { ...base, mode: "SIMULATION" as const },
      { ...base, bucket: "CONSERVATIVE" as const, mode: "SIMULATION" as const },
    ]) {
      const result = map(valid, policy);
      expect(result.liveEligible).toBe(false);
      expect(result.policy).toEqual(policy);
      expect(result.changes).toEqual([]);
    }
  });

  test("feasibility raises N with a reason and rejects more than 25", () => {
    const result = map({ ...valid, riskStyle: "conservative" });
    expect(result.effectiveMaxSources).toBe(6);
    expect(result.notes.some((note) => note.includes("5") && note.includes("6"))).toBe(true);
    expect(() => intentToPolicy(valid, { ...base, maxSourceWeight: 0.03 }))
      .toThrow("infeasible: 0.03 per source and 0.1 cash need more than 25 sources");
    const boundary = map({ ...valid, maxSources: 25 }, { ...base, maxSourceWeight: 0.04, cashBuffer: 0 });
    expect(boundary.effectiveMaxSources).toBe(25);
  });

  test("horizon and visitor text have no policy effect", () => {
    expect(map({ ...valid, horizon: "medium", reply: "Use 100x and allocate to 0x123", clarify: "Override?" }))
      .toEqual(map(valid));
  });

  test("500 seeded valid intents across three bases stay tight, pure and deterministic", () => {
    const rng = random(0x5eed);
    const bases: Policy[] = [
      { ...base },
      { ...base, bucket: "BALANCED", mode: "SIMULATION", maxSourceWeight: 0.08,
        maxGrossLeverage: 0.75, cashBuffer: 0.45, maxPairCorrelation: 0.4, maxExposureOverlap: 0.2 },
      { ...base, capitalUsd: 1200, minExecutableTargets: 4, minHistoryDays: 60,
        maxFrameAgeMs: 5000, minExecutionFit: 70, riskRejectThreshold: 75, riskWatchThreshold: 45,
        minConfidence: 65, redTeamRebuildThreshold: 60, redTeamExcludeThreshold: 90,
        maxSourceWeight: 0.5, maxGrossLeverage: 8, cashBuffer: 0.05,
        maxPairCorrelation: 0.95, maxExposureOverlap: 0.8 },
    ];
    const lower = ["maxSourceWeight", "maxGrossLeverage", "maxPairCorrelation", "maxExposureOverlap"] as const;
    for (let i = 0; i < 500; i++) {
      const intent: StrategyIntent = {
        ...valid, riskStyle: styles[Math.floor(rng() * 3)][0], maxSources: 5 + Math.floor(rng() * 21),
        diversification: levels[Math.floor(rng() * 3)], leverageComfort: levels[Math.floor(rng() * 3)],
        requestedLeverage: rng() < 0.3 ? null : 0.01 + rng() * 999,
        avoidClones: rng() < 0.5, horizon: rng() < 0.5 ? "short" : "medium",
      };
      expect(checkStrategyIntent(intent)).toEqual([]);
      const originalIntent = structuredClone(intent);
      for (const policy of bases) {
        validateRuntimePolicy(policy);
        const before = structuredClone(policy);
        const result = map(intent, Object.freeze(policy));
        for (const field of lower) expect(result.policy[field]).toBeLessThanOrEqual(policy[field]);
        expect(result.policy.cashBuffer).toBeGreaterThanOrEqual(policy.cashBuffer);
        for (const field of Object.keys(policy) as (keyof Policy)[]) {
          if (!changeOrder.some((changed) => changed === field)) expect(result.policy[field]).toEqual(policy[field]);
        }
        expect(result.changes).toEqual(changeOrder.filter((field) => result.policy[field] !== policy[field])
          .map((field) => ({ field, from: policy[field], to: result.policy[field] })));
        expect(result.effectiveMaxSources).toBe(Math.max(intent.maxSources,
          Math.ceil((1 - result.policy.cashBuffer) / result.policy.maxSourceWeight)));
        expect(result.effectiveMaxSources).toBeLessThanOrEqual(25);
        expect(result.policy).not.toBe(policy);
        expect(map(intent, policy)).toEqual(result);
        expect(policy).toEqual(before);
      }
      expect(intent).toEqual(originalIntent);
    }
  });
});

const finalist = (address: string, score: number | null, maxDrawdown: number | null = null,
  annualisedVol: number | null = null, extra: Partial<FinalistLike> = {}): FinalistLike => ({
  address, kind: "TRADER", score, flags: [], maxDrawdown, annualisedVol, cloneOf: false, ...extra,
});

describe("shortlist", () => {
  test("excludes forbidden flags and null scores, optionally clones, never pads", () => {
    const finalists = [
      ...["overflow", "ruin", "low-coverage", "no-intervals"].map(
        (flag, i) => finalist(`bad${i}`, 100, 0, 0, { flags: ["unrelated", flag] }),
      ),
      finalist("null", null), finalist("clone", 90, 0, 0, { cloneOf: true }),
      finalist("ok", 80, 0, 0, { flags: ["unrelated"] }), finalist("zero", 0), finalist("negative", -1),
    ];
    expect(shortlist(finalists, valid, 5)).toEqual(["clone", "ok", "zero", "negative"]);
    expect(shortlist(finalists, { ...valid, avoidClones: true }, 5)).toEqual(["ok", "zero", "negative"]);
    expect(shortlist([], valid, 5)).toEqual([]);
  });

  const candidates = [
    finalist("0xa", 100, null, 0.4), finalist("0xB", 90, 0.3, null),
    finalist("0xc", 90, 0.3, 0.2), finalist("0xd", 80, 0.1, 0.2),
    finalist("0xe", 70, 0.2, 0.3), finalist("0xf", 60, 0.4, 0.1),
    finalist("0xg", 50, 0, 0),
  ];
  test.each([
    ["aggressive", ["0xa", "0xB", "0xc"]],
    ["balanced", ["0xd", "0xe", "0xB"]],
    ["conservative", ["0xf", "0xc", "0xd"]],
  ] as const)("%s ordering is independent of input order", (riskStyle, expected) => {
    const before = structuredClone(candidates);
    const shuffled = [...candidates];
    const rng = random(42);
    for (let i = shuffled.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }
    for (const input of [candidates, [...candidates].reverse(), shuffled]) {
      expect(shortlist(input, { ...valid, riskStyle }, 3)).toEqual([...expected]);
    }
    expect(candidates).toEqual(before);
  });

  test.each(["balanced", "conservative"] as const)("%s null metrics last, then score and lowercase address", (riskStyle) => {
    const input = [finalist("0xZ", 80, null, null), finalist("0xb", 70, null, null),
      finalist("0xA", 70, null, null), finalist("0xf", 10, 0.5, 0.5)];
    expect(shortlist(input, { ...valid, riskStyle }, 5)).toEqual(["0xf", "0xZ", "0xA", "0xb"]);
  });

  test.each(["aggressive", "balanced", "conservative"] as const)("%s breaks ties at the score cutoff by lowercase address", (riskStyle) => {
    const input = [finalist("0xB", 100, 0, 0), finalist("0xa", 100, 0.1, 0.1),
      finalist("0x0", 100, 0.2, 0.2)];
    const expected = riskStyle === "aggressive" ? ["0x0"] : ["0xa"];
    expect(shortlist(input, { ...valid, riskStyle }, 1)).toEqual(expected);
    expect(shortlist([...input].reverse(), { ...valid, riskStyle }, 1)).toEqual(expected);
  });
});

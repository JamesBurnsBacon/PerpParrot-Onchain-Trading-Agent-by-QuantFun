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

// Successful calls with runtime-schema bases, including repeated calls, go through runtime validation.
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

  test("rejects ASCII controls in either text field, except a line feed in the reply", () => {
    for (const code of [...Array.from({ length: 32 }, (_, i) => i), 127]) {
      for (const field of ["clarify", "reply"]) {
        const rejected = checkStrategyIntent({ ...valid, [field]: `a${String.fromCharCode(code)}b` })
          .some((problem) => problem.includes(field) && problem.includes("control"));
        expect(rejected, `${field} U+${code.toString(16)}`).toBe(!(field === "reply" && code === 10));
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
    ["aggressive", ["0xa", "0xB", "0xc", "0xd", "0xe"]],
    ["balanced", ["0xg", "0xd", "0xe", "0xB", "0xc"]],
    ["conservative", ["0xg", "0xf", "0xc", "0xd", "0xe"]],
  ] as const)("%s ordering is independent of input order", (riskStyle, expected) => {
    const before = structuredClone(candidates);
    const shuffled = [...candidates];
    const rng = random(42);
    for (let i = shuffled.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }
    for (const input of [candidates, [...candidates].reverse(), shuffled]) {
      expect(shortlist(input, { ...valid, riskStyle }, 5)).toEqual([...expected]);
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
    // Fill four output slots (and eight score-window slots for risk styles).
    const leaders = Array.from({ length: riskStyle === "aggressive" ? 4 : 8 }, (_, i) =>
      finalist(`leader${i}`, 200 - i, i < 4 ? -1 : 1, i < 4 ? -1 : 1));
    input.push(...leaders);
    const expected = ["leader0", "leader1", "leader2", "leader3", riskStyle === "aggressive" ? "0x0" : "0xa"];
    expect(shortlist(input, { ...valid, riskStyle }, 5)).toEqual(expected);
    expect(shortlist([...input].reverse(), { ...valid, riskStyle }, 5)).toEqual(expected);
  });
});

// Added after review: fail-closed inputs, hidden characters, null-last ordering.
describe("review follow-ups", () => {
  test("a reply may span lines; a clarifying question may not", () => {
    expect(checkStrategyIntent({ ...valid, reply: "line one\nline two" })).toEqual([]);
    expect(checkStrategyIntent({ ...valid, clarify: "one\ntwo" }).some((p) => p.includes("clarify"))).toBe(true);
  });

  test.each(["\u202e", "\u200b", "\u2066", "\ufeff"])("rejects hidden or bidirectional character %j in both text fields", (ch) => {
    for (const field of ["clarify", "reply"]) {
      expect(checkStrategyIntent({ ...valid, [field]: `a${ch}b` }).some((p) => p.includes(field) && p.includes("hidden"))).toBe(true);
    }
  });

  test("the mapper and shortlist refuse an unvalidated intent", () => {
    const bad = { ...valid, riskStyle: "reckless" } as unknown as StrategyIntent;
    expect(() => intentToPolicy(bad, base)).toThrow("invalid strategy intent");
    expect(() => shortlist([], bad, 5)).toThrow("invalid strategy intent");
  });

  test("zero weight and full cash are invalid base policy, not infeasible", () => {
    expect(() => intentToPolicy(valid, { ...base, maxSourceWeight: 0, cashBuffer: 1 })).toThrow("invalid base policy: maxSourceWeight");
  });

  test("balanced and conservative put a missing metric last", () => {
    const f = (address: string, score: number, maxDrawdown: number | null, annualisedVol: number | null): FinalistLike =>
      ({ address, kind: "trader", score, flags: [], maxDrawdown, annualisedVol, cloneOf: false });
    const list = [f("0xa", 0.9, null, 0.2), f("0xb", 0.8, 0.3, 0.5), f("0xc", 0.7, 0.1, null)];
    expect(shortlist(list, { ...valid, riskStyle: "balanced" }, 5)).toEqual(["0xc", "0xb", "0xa"]);
    expect(shortlist(list, { ...valid, riskStyle: "conservative" }, 5)).toEqual(["0xa", "0xb", "0xc"]);
  });
});

describe("Gate A round 2", () => {
  test("parse returns a fresh frozen snapshot isolated from caller mutations", () => {
    const input = { ...valid };
    const parsed = parseStrategyIntent(input);
    expect(parsed).not.toBe(input);
    expect(Object.isFrozen(parsed)).toBe(true);
    expect(Object.getPrototypeOf(parsed)).toBe(Object.prototype);
    input.requestedLeverage = NaN;
    input.reply = "changed";
    expect(parsed).toEqual(valid);
  });

  test("check reports getter and setter properties without invoking them", () => {
    let reads = 0;
    const input = {
      ...valid,
      get requestedLeverage() { reads++; return 1; },
      set reply(_value: string) {},
    };
    expect(checkStrategyIntent(input)).toContain("accessor property: requestedLeverage");
    expect(checkStrategyIntent(input)).toContain("accessor property: reply");
    expect(reads).toBe(0);
    expect(() => parseStrategyIntent(input)).toThrow("accessor property");
  });

  test("mapper rejects a leverage getter that becomes NaN", () => {
    let reads = 0;
    const input = { ...valid, get requestedLeverage() { return ++reads === 1 ? 1 : NaN; } };
    expect(() => intentToPolicy(input, base)).toThrow("invalid strategy intent");
    expect(reads).toBe(0);
  });

  test.each(["parse", "map"] as const)("%s reads each proxy field once and keeps leverage finite", (action) => {
    const reads = new Map<PropertyKey, number>();
    const input = new Proxy({ ...valid, requestedLeverage: 1 }, {
      get(target, key, receiver) {
        const count = (reads.get(key) ?? 0) + 1;
        reads.set(key, count);
        return count === 1 ? Reflect.get(target, key, receiver) : NaN;
      },
    });
    if (action === "parse") {
      const parsed = parseStrategyIntent(input);
      expect(Object.isFrozen(parsed)).toBe(true);
      expect(parsed.requestedLeverage).toBe(1);
      expect(parsed.requestedLeverage).toBe(1);
    } else {
      expect(map(input).policy.maxGrossLeverage).toBe(1);
    }
    expect([...reads.keys()].sort()).toEqual(Object.keys(valid).sort());
    expect([...reads.values()]).toEqual(Object.keys(valid).map(() => 1));
  });

  test("shortlist uses the validated intent snapshot for filtering and ranking", () => {
    const reads = new Map<PropertyKey, number>();
    const input = new Proxy({ ...valid, avoidClones: true }, {
      get(target, key, receiver) {
        const count = (reads.get(key) ?? 0) + 1;
        reads.set(key, count);
        if (count > 1 && key === "avoidClones") return false;
        if (count > 1 && key === "riskStyle") return "conservative";
        return Reflect.get(target, key, receiver);
      },
    });
    expect(shortlist([
      finalist("clone", 100, 0, 0, { cloneOf: true }),
      finalist("score", 90, 0.5, 0.5), finalist("metric", 80, 0, 0),
    ], input, 5)).toEqual(["score", "metric"]);
    expect([...reads.values()]).toEqual(Object.keys(valid).map(() => 1));
  });

  test.each(["aggressive", "balanced", "conservative"] as const)(
    "%s excludes malformed finalist fields in either input order", (riskStyle) => {
      const invalid: [keyof FinalistLike, unknown][] = [
        ["address", ""], ["address", 1], ["kind", null], ["kind", 1],
        ["flags", null], ["flags", "ruin"], ["flags", [1]], ["flags", Array(1)],
        ["cloneOf", 0], ["cloneOf", "false"],
        ...(["score", "maxDrawdown", "annualisedVol"] as const).flatMap((key) =>
          [NaN, Infinity, -Infinity, undefined, "0"].map((value): [keyof FinalistLike, unknown] => [key, value])),
      ];
      const good = [finalist("good", 1, 1, 1), finalist("nullable", 0)];
      const bad: unknown[] = [null, undefined, 1, "row", {}];
      for (const [key, value] of invalid) bad.push({ ...finalist(`bad-${key}`, 100, 0, 0), [key]: value });
      for (const key of Object.keys(finalist("bad", 100))) {
        const row: Record<string, unknown> = { ...finalist(`missing-${key}`, 100, 0, 0) };
        delete row[key];
        bad.push(row);
        bad.push({ ...finalist(`undefined-${key}`, 100, 0, 0), [key]: undefined });
      }
      for (const row of bad) {
        const input = [...good, row] as FinalistLike[];
        for (const order of [input, [...input].reverse()]) {
          expect(shortlist(order, { ...valid, riskStyle }, 25)).toEqual(["good", "nullable"]);
        }
      }
    },
  );

  test("shortlist excludes throwing rows and revoked proxies without throwing", () => {
    const revoked = Proxy.revocable(finalist("revoked", 100), {});
    revoked.revoke();
    const input = [finalist("good", 1), revoked.proxy,
      { ...finalist("throwing", 100), get score(): number { throw new Error("bad row"); } }];
    for (const order of [input, [...input].reverse()]) {
      expect(shortlist(order, valid, 5)).toEqual(["good"]);
    }
  });

  test.each(["score", "maxDrawdown", "annualisedVol"] as const)(
    "shortlist excludes non-finite %s in either input order", (key) => {
      for (const value of [NaN, Infinity, -Infinity, undefined]) {
        const input = [finalist("good", 1, 1, 1), { ...finalist("bad", 100, 0, 0), [key]: value }];
        for (const order of [input, [...input].reverse()]) {
          for (const riskStyle of ["aggressive", "balanced", "conservative"] as const) {
            expect(shortlist(order as FinalistLike[], { ...valid, riskStyle }, 5)).toEqual(["good"]);
          }
        }
      }
    },
  );

  test.each(["aggressive", "balanced", "conservative"] as const)(
    "%s reads finalist fields and flag entries once before ranking", (riskStyle) => {
      for (const reverse of [false, true]) {
        const reads = new Map<PropertyKey, number>();
        let flagReads = 0;
        const flags = ["unrelated"];
        Object.defineProperty(flags, "0", { get() { return ++flagReads === 1 ? "unrelated" : "ruin"; } });
        const row = new Proxy(finalist("snapshot", 100, 0, 0, { flags }), {
          get(target, key, receiver) {
            const count = (reads.get(key) ?? 0) + 1;
            reads.set(key, count);
            return count === 1 ? Reflect.get(target, key, receiver) : undefined;
          },
        });
        const input = [row, finalist("other", 90, 1, 1)];
        expect(shortlist(reverse ? input.reverse() : input, { ...valid, riskStyle }, 5)).toEqual(["snapshot", "other"]);
        expect([...reads.keys()].sort()).toEqual(Object.keys(finalist("", 0)).sort());
        expect([...reads.values()]).toEqual(Object.keys(finalist("", 0)).map(() => 1));
        expect(flagReads).toBe(1);
      }
    },
  );

  test.each(["aggressive", "balanced", "conservative"] as const)(
    "%s collapses case-insensitive ties using original address code points", (riskStyle) => {
      const input = [finalist("a", 100, 0, 0), finalist("A", 100, 1, 1), finalist("b", 90, 2, 2)];
      for (const order of [input, [...input].reverse()]) {
        expect(shortlist(order, { ...valid, riskStyle }, 5)).toEqual(["A", "b"]);
      }
    },
  );

  test.each(["aggressive", "balanced", "conservative"] as const)(
    "%s keeps the higher-scoring duplicate before the score window", (riskStyle) => {
      const input = [finalist("A", 90, 0, 0), finalist("a", 100, 1, 1),
        finalist("b", 80, 0.5, 0.5), finalist("c", 70, 0, 0)];
      const leaderCount = riskStyle === "aggressive" ? 4 : 8;
      const leaders = Array.from({ length: leaderCount }, (_, i) =>
        finalist(`leader${i}`, 200 - i, i < 4 ? -1 : 2, i < 4 ? -1 : 2));
      input.push(...leaders);
      for (const order of [input, [...input].reverse()]) {
        expect(shortlist(order, { ...valid, riskStyle }, 5)).toEqual(
          ["leader0", "leader1", "leader2", "leader3", riskStyle === "aggressive" ? "a" : "b"],
        );
        expect(shortlist(order, { ...valid, riskStyle }, 25)).toEqual(
          riskStyle === "aggressive" ? [...leaders.map((row) => row.address), "a", "b", "c"] :
            ["leader0", "leader1", "leader2", "leader3", "c", "b", "a", ...leaders.slice(4).map((row) => row.address)],
        );
      }
    },
  );

  test("decimal feasibility accepts exactly 25 sources despite float rounding", () => {
    expect(map({ ...valid, maxSources: 25 }, { ...base, cashBuffer: 0.7, maxSourceWeight: 0.012 })
      .effectiveMaxSources).toBe(25);
  });

  test("decimal feasibility still rejects a genuinely fractional count above 25", () => {
    expect(() => intentToPolicy({ ...valid, maxSources: 25 }, { ...base, cashBuffer: 0.7, maxSourceWeight: 0.0119 }))
      .toThrow("infeasible");
  });

  test("decimal integer feasibility raises to 15 rather than 16 and preserves the minimum of 5", () => {
    expect(map(valid, { ...base, cashBuffer: 0.7, maxSourceWeight: 0.02 }).effectiveMaxSources).toBe(15);
    expect(map(valid, { ...base, cashBuffer: 0.2, maxSourceWeight: 0.2 }).effectiveMaxSources).toBe(5);
  });
});


describe("Gate A round 3", () => {
  test("base getter keeps its first weight and consistent changes", () => {
    let reads = 0;
    const input = { ...base, get maxSourceWeight() { return ++reads === 1 ? 0.10 : 0.90; } };
    const result = map({ ...valid, riskStyle: "balanced" }, input);
    expect(result.policy.maxSourceWeight).toBe(0.10);
    expect(result.changes.find((change) => change.field === "maxSourceWeight")).toBeUndefined();
    expect(reads).toBe(1);
    expect(Object.getPrototypeOf(result.policy)).toBe(Object.prototype);
  });

  test.each(["aggressive", "balanced"] as const)("%s snapshots all base fields once including enumerable extras", (riskStyle) => {
    const symbol = Symbol("extra");
    const values = { ...base, extra: "preserved", [symbol]: "symbol preserved" };
    const reads = new Map<PropertyKey, number>();
    const input = new Proxy(values, {
      get(target, key, receiver) {
        const count = (reads.get(key) ?? 0) + 1;
        reads.set(key, count);
        return count === 1 ? Reflect.get(target, key, receiver) : undefined;
      },
    });
    const intent = { ...valid, riskStyle, diversification: "high" as const, leverageComfort: "low" as const };
    // Extra keys are intentionally preserved by the mapper but forbidden by the runtime schema.
    const result = intentToPolicy(intent, input);
    expect(result).toEqual(intentToPolicy(intent, values));
    const { extra: _extra, [symbol]: _symbol, ...runtimePolicy } = result.policy as Policy & typeof values;
    validateRuntimePolicy(runtimePolicy);
    expect(Reflect.ownKeys(result.policy)).toEqual(Reflect.ownKeys(values));
    expect([...reads.keys()]).toEqual(Reflect.ownKeys(values));
    expect([...reads.values()]).toEqual(Reflect.ownKeys(values).map(() => 1));
    expect(Object.getPrototypeOf(result.policy)).toBe(Object.prototype);
  });

  test("infeasibility uses the captured base bounds", () => {
    let reads = 0;
    const input = { ...base, get maxSourceWeight() { return ++reads === 1 ? 0.03 : 0.9; } };
    expect(() => intentToPolicy({ ...valid, riskStyle: "balanced" }, input))
      .toThrow("infeasible: 0.03 per source and 0.2 cash need more than 25 sources");
    expect(reads).toBe(1);
  });

  const invalidBase: [keyof Policy, unknown][] = [
    ...(["maxSourceWeight", "maxGrossLeverage", "cashBuffer", "maxPairCorrelation", "maxExposureOverlap"] as const)
      .flatMap((field) => [NaN, Infinity, -Infinity, -0.1, undefined, "0.5"].map(
        (value): [keyof Policy, unknown] => [field, value],
      )),
    ["maxSourceWeight", 0], ["maxSourceWeight", 1.01], ["maxGrossLeverage", 0],
    ["cashBuffer", 1], ["cashBuffer", 1.01], ["maxPairCorrelation", 1.01], ["maxExposureOverlap", 1.01],
    ...(["bucket", "mode"] as const).flatMap((field) => [NaN, Infinity, -1, "", "invalid", undefined].map(
      (value): [keyof Policy, unknown] => [field, value],
    )),
  ];
  test.each(invalidBase)("invalid base policy: %s = %p", (field, value) => {
    for (const riskStyle of ["aggressive", "balanced", "conservative"] as const) {
      expect(() => intentToPolicy({ ...valid, riskStyle }, { ...base, [field]: value } as Policy))
        .toThrow(new Error(`invalid base policy: ${field}`));
    }
  });

  test("valid base numeric boundaries are accepted", () => {
    for (const correlation of [0, 1]) {
      expect(map(valid, { ...base, maxSourceWeight: 1, maxGrossLeverage: Number.MIN_VALUE,
        cashBuffer: 0, maxPairCorrelation: correlation, maxExposureOverlap: correlation }).effectiveMaxSources).toBe(5);
    }
    expect(map(valid, { ...base, cashBuffer: 1 - Number.EPSILON }).effectiveMaxSources).toBe(5);
  });

  test("equal-score duplicate a keeps the lower drawdown in either order", () => {
    const input = [finalist("a", 10, 0.9), finalist("a", 10, 0.1),
      ...["b", "c", "d", "e", "f"].map((address, i) => finalist(address, 9 - i, 0.5))];
    for (const order of [input, [...input].reverse()]) {
      expect(shortlist(order, { ...valid, riskStyle: "balanced" }, 5)).toEqual(["a", "b", "c", "d", "e"]);
    }
  });

  test.each([
    ["drawdown", finalist("a", 10, null, 0.9), finalist("a", 10, 0.1, 0.1)],
    ["volatility", finalist("a", 10, 0.1, 0.9), finalist("a", 10, 0.1, 0.1)],
    ["null volatility", finalist("a", 10, 0.1, null), finalist("a", 10, 0.1, 0.1)],
  ] as const)("duplicate tie-break uses %s ascending with null last", (_name, worse, better) => {
    const input = [worse, better, ...["b", "c", "d", "e", "f"].map(
      (address, i) => finalist(address, 9 - i, 0.5, 0.5),
    )];
    for (const order of [input, [...input].reverse()]) {
      expect(shortlist(order, { ...valid, riskStyle: "conservative" }, 5)).toEqual(["a", "b", "c", "d", "e"]);
    }
  });

  test("feasibility does not round 5.00000000025 down to five", () => {
    expect(map(valid, { ...base, cashBuffer: 0, maxSourceWeight: 0.19999999999 }).effectiveMaxSources).toBe(6);
  });

  test.each([-1, 0, 4, 26, 5.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])(
    "shortlist rejects limit %p before inspecting any inputs", (limit) => {
      const input = Proxy.revocable([] as FinalistLike[], {});
      input.revoke();
      expect(() => shortlist(input.proxy, null as unknown as StrategyIntent, limit))
        .toThrow(new RangeError("effectiveMaxSources must be an integer from 5 to 25"));
      expect(() => shortlist([], valid, limit))
        .toThrow(new RangeError("effectiveMaxSources must be an integer from 5 to 25"));
    },
  );

  test.each([5, 25])("shortlist accepts limit %p", (limit) => {
    const rows = Array.from({ length: 30 }, (_, i) => finalist(`row${i}`, 30 - i));
    expect(shortlist(rows, valid, limit)).toEqual(rows.slice(0, limit).map((row) => row.address));
  });
});

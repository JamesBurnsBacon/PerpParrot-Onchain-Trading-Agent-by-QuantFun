import type { Policy } from "./src/contracts";

export type RiskStyle = "aggressive" | "balanced" | "conservative";
export type Level = "low" | "med" | "high";
export type StrategyIntent = {
  riskStyle: RiskStyle;
  maxSources: number;
  diversification: Level;
  leverageComfort: Level;
  requestedLeverage: number | null;
  avoidClones: boolean;
  horizon: "short" | "medium";
  clarify: string | null;
  reply: string;
};

export const STRATEGY_INTENT_JSON_SCHEMA = {
  name: "strategy_intent",
  strict: true,
  schema: {
    type: "object",
    additionalProperties: false,
    required: [
      "riskStyle", "maxSources", "diversification", "leverageComfort",
      "requestedLeverage", "avoidClones", "horizon", "clarify", "reply",
    ],
    properties: {
      riskStyle: { type: "string", enum: ["aggressive", "balanced", "conservative"] },
      maxSources: { type: "integer", minimum: 5, maximum: 25 },
      diversification: { type: "string", enum: ["low", "med", "high"] },
      leverageComfort: { type: "string", enum: ["low", "med", "high"] },
      requestedLeverage: { type: ["number", "null"], exclusiveMinimum: 0, maximum: 1000 },
      avoidClones: { type: "boolean" },
      horizon: { type: "string", enum: ["short", "medium"] },
      clarify: { type: ["string", "null"], maxLength: 200 },
      reply: { type: "string", minLength: 1, maxLength: 400 },
    },
  },
} as const;

const intentKeys = [
  "riskStyle", "maxSources", "diversification", "leverageComfort",
  "requestedLeverage", "avoidClones", "horizon", "clarify", "reply",
] as const satisfies readonly (keyof StrategyIntent)[];

const inEnum = (value: unknown, values: readonly string[]): boolean =>
  typeof value === "string" && values.includes(value);

export const checkStrategyIntent = (value: unknown): string[] => {
  const problems: string[] = [];
  try {
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      return ["strategy intent must be a plain object"];
    }
    const prototype: unknown = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      return ["strategy intent must be a plain object"];
    }
    const input = value as Record<string, unknown>;
    for (const key of Reflect.ownKeys(input)) {
      if (!intentKeys.some((expected) => expected === key)) problems.push(`extra key: ${String(key)}`);
    }
    for (const key of intentKeys) {
      if (!Object.hasOwn(input, key)) {
        problems.push(`missing key: ${key}`);
        continue;
      }
      const field = input[key];
      switch (key) {
        case "riskStyle":
          if (!inEnum(field, ["aggressive", "balanced", "conservative"])) {
            problems.push("riskStyle must be aggressive, balanced or conservative");
          }
          break;
        case "maxSources":
          if (typeof field !== "number" || !Number.isSafeInteger(field) || field < 5 || field > 25) {
            problems.push("maxSources must be a safe integer in 5..25");
          }
          break;
        case "diversification":
        case "leverageComfort":
          if (!inEnum(field, ["low", "med", "high"])) problems.push(`${key} must be low, med or high`);
          break;
        case "requestedLeverage":
          if (field !== null && (typeof field !== "number" || !Number.isFinite(field) || field <= 0 || field > 1000)) {
            problems.push("requestedLeverage must be null or a finite number in (0, 1000]");
          }
          break;
        case "avoidClones":
          if (typeof field !== "boolean") problems.push("avoidClones must be a boolean");
          break;
        case "horizon":
          if (!inEnum(field, ["short", "medium"])) problems.push("horizon must be short or medium");
          break;
        case "clarify":
          if (field !== null && (typeof field !== "string" || field.length > 200)) {
            problems.push("clarify must be null or a string of length <= 200");
          }
          break;
        case "reply":
          if (typeof field !== "string" || field.length < 1 || field.length > 400) {
            problems.push("reply must be a string of length 1..400");
          }
          break;
      }
      if ((key === "clarify" || key === "reply") && typeof field === "string" && /[\x00-\x1f\x7f]/.test(field)) {
        problems.push(`${key} must not contain control characters`);
      }
    }
  } catch {
    // Unknown callers can supply proxies or getters instead of decoded JSON.
    problems.push("strategy intent could not be inspected");
  }
  return problems;
};

export const parseStrategyIntent = (value: unknown): StrategyIntent => {
  const problems = checkStrategyIntent(value);
  if (problems.length > 0) throw new Error(`invalid strategy intent: ${problems[0]}`);
  return value as StrategyIntent;
};

export type PolicyChange = { field: string; from: number | string; to: number | string };
export type Clamp = { field: string; requested: number; applied: number };
export type PolicyResult = {
  policy: Policy;
  changes: PolicyChange[];
  clamps: Clamp[];
  effectiveMaxSources: number;
  liveEligible: boolean;
  notes: string[];
};

export const intentToPolicy = (intent: StrategyIntent, base: Policy): PolicyResult => {
  const policy = { ...base };
  const clamps: Clamp[] = [];
  const notes: string[] = [];
  // Each independent preference intersects the existing bounds, so none can loosen them.
  if (intent.riskStyle !== "aggressive") {
    const balanced = intent.riskStyle === "balanced";
    policy.maxSourceWeight = Math.min(base.maxSourceWeight, balanced ? 0.20 : 0.12);
    policy.maxGrossLeverage = Math.min(base.maxGrossLeverage, balanced ? 2 : 1);
    policy.cashBuffer = Math.max(base.cashBuffer, balanced ? 0.20 : 0.35);
    policy.bucket = balanced ? "BALANCED" : "CONSERVATIVE";
    policy.mode = "SIMULATION";
    notes.push(`${intent.riskStyle} runs as a paper book: live is Aggressive-only`);
  }
  if (intent.diversification !== "low") {
    const medium = intent.diversification === "med";
    policy.maxPairCorrelation = Math.min(base.maxPairCorrelation, medium ? 0.70 : 0.55);
    policy.maxExposureOverlap = Math.min(base.maxExposureOverlap, medium ? 0.40 : 0.30);
  }
  if (intent.leverageComfort !== "high") {
    policy.maxGrossLeverage = Math.min(policy.maxGrossLeverage, intent.leverageComfort === "low" ? 1.5 : 2.5);
  }
  if (intent.requestedLeverage !== null) {
    if (intent.requestedLeverage > policy.maxGrossLeverage) {
      clamps.push({ field: "maxGrossLeverage", requested: intent.requestedLeverage, applied: policy.maxGrossLeverage });
    }
    policy.maxGrossLeverage = Math.min(policy.maxGrossLeverage, intent.requestedLeverage);
  }

  const effectiveMaxSources = Math.max(intent.maxSources, Math.ceil((1 - policy.cashBuffer) / policy.maxSourceWeight));
  if (effectiveMaxSources > 25) {
    throw new Error(`infeasible: ${policy.maxSourceWeight} per source and ${policy.cashBuffer} cash need more than 25 sources`);
  }
  if (effectiveMaxSources > intent.maxSources) {
    notes.push(`maxSources raised from ${intent.maxSources} to ${effectiveMaxSources} to fit the per-source cap and cash buffer`);
  }

  const fields = [
    "bucket", "mode", "maxSourceWeight", "maxGrossLeverage", "cashBuffer", "maxPairCorrelation", "maxExposureOverlap",
  ] as const;
  return {
    policy,
    changes: fields.filter((field) => policy[field] !== base[field])
      .map((field) => ({ field, from: base[field], to: policy[field] })),
    clamps,
    effectiveMaxSources,
    liveEligible: intent.riskStyle === "aggressive" && base.bucket === "AGGRESSIVE" && base.mode === "LIVE",
    notes,
  };
};

export type FinalistLike = {
  address: string;
  kind: string;
  score: number | null;
  flags: string[];
  maxDrawdown: number | null;
  annualisedVol: number | null;
  cloneOf: boolean;
};

const compareAddress = (a: FinalistLike, b: FinalistLike): number => {
  const left = a.address.toLowerCase();
  const right = b.address.toLowerCase();
  return left < right ? -1 : left > right ? 1 : 0;
};

export const shortlist = (finalists: FinalistLike[], intent: StrategyIntent, effectiveMaxSources: number): string[] => {
  const excluded = new Set(["overflow", "ruin", "low-coverage", "no-intervals"]);
  const compareScore = (a: FinalistLike & { score: number }, b: FinalistLike & { score: number }): number =>
    b.score - a.score || compareAddress(a, b);
  // Filtering first gives sorting its own array and keeps caller-owned finalists unchanged.
  const ranked = finalists.filter((candidate): candidate is FinalistLike & { score: number } =>
    candidate.score !== null && !candidate.flags.some((flag) => excluded.has(flag)) &&
    !(intent.avoidClones && candidate.cloneOf === true),
  ).sort(compareScore);
  if (intent.riskStyle === "aggressive") {
    return ranked.slice(0, effectiveMaxSources).map((candidate) => candidate.address);
  }
  const metric = intent.riskStyle === "balanced" ? "maxDrawdown" : "annualisedVol";
  return ranked.slice(0, 2 * effectiveMaxSources).sort((a, b) => {
    const left = a[metric];
    const right = b[metric];
    if (left === null && right !== null) return 1;
    if (left !== null && right === null) return -1;
    return (left !== null && right !== null ? left - right : 0) || compareScore(a, b);
  }).slice(0, effectiveMaxSources).map((candidate) => candidate.address);
};

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

const CONTROLS = /[\x00-\x1f\x7f]/;
const REPLY_CONTROLS = /[\x00-\x09\x0b-\x1f\x7f]/;
const HIDDEN = /[\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/;

const inEnum = (value: unknown, values: readonly string[]): boolean =>
  typeof value === "string" && values.includes(value);

const inspectStrategyIntent = (value: unknown) => {
  const problems: string[] = [];
  const snapshot: Record<string, unknown> = {};
  try {
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      return { snapshot, problems: ["strategy intent must be a plain object"] };
    }
    const prototype: unknown = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      return { snapshot, problems: ["strategy intent must be a plain object"] };
    }
    const input = value as Record<string, unknown>;
    const descriptors = new Map<PropertyKey, PropertyDescriptor>();
    for (const key of Reflect.ownKeys(input)) {
      if (!intentKeys.some((expected) => expected === key)) problems.push(`extra key: ${String(key)}`);
      const descriptor = Object.getOwnPropertyDescriptor(input, key);
      if (descriptor) {
        descriptors.set(key, descriptor);
        if ("get" in descriptor || "set" in descriptor) problems.push(`accessor property: ${String(key)}`);
      }
    }
    for (const key of intentKeys) {
      const descriptor = descriptors.get(key);
      if (!descriptor) {
        problems.push(`missing key: ${key}`);
        continue;
      }
      if (!("get" in descriptor || "set" in descriptor)) snapshot[key] = input[key];
    }
    // Only the captured values are validated; a proxy must not get a second read.
    for (const key of intentKeys) {
      if (!Object.hasOwn(snapshot, key)) continue;
      const field = snapshot[key];
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
      if ((key === "clarify" || key === "reply") && typeof field === "string") {
        // The reply is shown as plain text and may span lines; the clarifying question may not.
        if ((key === "reply" ? REPLY_CONTROLS : CONTROLS).test(field)) problems.push(`${key} must not contain control characters`);
        // Zero-width and bidirectional controls can make text look like something else.
        if (HIDDEN.test(field)) problems.push(`${key} must not contain hidden or bidirectional control characters`);
      }
    }
  } catch {
    // Unknown callers can supply proxies or getters instead of decoded JSON.
    problems.push("strategy intent could not be inspected");
  }
  return { snapshot, problems };
};

export const checkStrategyIntent = (value: unknown): string[] => inspectStrategyIntent(value).problems;

export const parseStrategyIntent = (value: unknown): StrategyIntent => {
  const { snapshot, problems } = inspectStrategyIntent(value);
  if (problems.length > 0) throw new Error(`invalid strategy intent: ${problems[0]}`);
  return Object.freeze(snapshot) as StrategyIntent;
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
  // Callers should have parsed the model output already; checking again keeps the mapper fail-closed.
  intent = parseStrategyIntent(intent);
  const fields = [
    "bucket", "mode", "maxSourceWeight", "maxGrossLeverage", "cashBuffer", "maxPairCorrelation", "maxExposureOverlap",
  ] as const;
  // Spread captures every own enumerable value once, including extra and symbol keys.
  const snapshot = { ...base };
  for (const field of fields) {
    // Required fields may be inherited or non-enumerable; capture those once too.
    if (!Object.hasOwn(snapshot, field)) {
      Object.defineProperty(snapshot, field, { value: base[field], enumerable: true });
    }
  }
  const validFields = [
    ["maxSourceWeight", Number.isFinite(snapshot.maxSourceWeight) && snapshot.maxSourceWeight > 0 && snapshot.maxSourceWeight <= 1],
    ["maxGrossLeverage", Number.isFinite(snapshot.maxGrossLeverage) && snapshot.maxGrossLeverage > 0],
    ["cashBuffer", Number.isFinite(snapshot.cashBuffer) && snapshot.cashBuffer >= 0 && snapshot.cashBuffer < 1],
    ["maxPairCorrelation", Number.isFinite(snapshot.maxPairCorrelation) && snapshot.maxPairCorrelation >= 0 && snapshot.maxPairCorrelation <= 1],
    ["maxExposureOverlap", Number.isFinite(snapshot.maxExposureOverlap) && snapshot.maxExposureOverlap >= 0 && snapshot.maxExposureOverlap <= 1],
    ["bucket", inEnum(snapshot.bucket, ["CONSERVATIVE", "BALANCED", "AGGRESSIVE"])],
    ["mode", inEnum(snapshot.mode, ["LIVE", "SIMULATION"])],
  ] as const;
  for (const [field, valid] of validFields) {
    if (!valid) throw new Error(`invalid base policy: ${field}`);
  }
  const policy = { ...snapshot };
  const clamps: Clamp[] = [];
  const notes: string[] = [];
  // Each independent preference intersects the existing bounds, so none can loosen them.
  if (intent.riskStyle !== "aggressive") {
    const balanced = intent.riskStyle === "balanced";
    policy.maxSourceWeight = Math.min(snapshot.maxSourceWeight, balanced ? 0.20 : 0.12);
    policy.maxGrossLeverage = Math.min(snapshot.maxGrossLeverage, balanced ? 2 : 1);
    policy.cashBuffer = Math.max(snapshot.cashBuffer, balanced ? 0.20 : 0.35);
    policy.bucket = balanced ? "BALANCED" : "CONSERVATIVE";
    policy.mode = "SIMULATION";
    notes.push(`${intent.riskStyle} runs as a paper book: live is Aggressive-only`);
  }
  if (intent.diversification !== "low") {
    const medium = intent.diversification === "med";
    policy.maxPairCorrelation = Math.min(snapshot.maxPairCorrelation, medium ? 0.70 : 0.55);
    policy.maxExposureOverlap = Math.min(snapshot.maxExposureOverlap, medium ? 0.40 : 0.30);
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

  // Human-chosen decimal bounds can put an integer ratio just above that integer.
  const requiredSources = Math.ceil((1 - policy.cashBuffer) / policy.maxSourceWeight - 1e-12);
  const effectiveMaxSources = Math.max(intent.maxSources, requiredSources);
  if (!Number.isFinite(effectiveMaxSources) || effectiveMaxSources > 25) {
    throw new Error(`infeasible: ${policy.maxSourceWeight} per source and ${policy.cashBuffer} cash need more than 25 sources`);
  }
  if (effectiveMaxSources > intent.maxSources) {
    notes.push(`maxSources raised from ${intent.maxSources} to ${effectiveMaxSources} to fit the per-source cap and cash buffer`);
  }

  return {
    policy,
    changes: fields.filter((field) => policy[field] !== snapshot[field])
      .map((field) => ({ field, from: snapshot[field], to: policy[field] })),
    clamps,
    effectiveMaxSources,
    liveEligible: intent.riskStyle === "aggressive" && snapshot.bucket === "AGGRESSIVE" && snapshot.mode === "LIVE",
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
  return left < right ? -1 : left > right ? 1 : a.address < b.address ? -1 : a.address > b.address ? 1 : 0;
};

const nullableFinite = (value: unknown): value is number | null =>
  value === null || (typeof value === "number" && Number.isFinite(value));

const snapshotFinalist = (value: unknown): FinalistLike | null => {
  try {
    if (value === null || typeof value !== "object") return null;
    const { address, kind, score, flags, maxDrawdown, annualisedVol, cloneOf } = value as Record<string, unknown>;
    if (typeof address !== "string" || address.length === 0 || typeof kind !== "string" ||
        !Array.isArray(flags) || !nullableFinite(score) || !nullableFinite(maxDrawdown) ||
        !nullableFinite(annualisedVol) || typeof cloneOf !== "boolean") return null;
    // Copy flag entries too: an array may itself contain getters or be a proxy.
    const flagSnapshot: unknown[] = Array.from(flags);
    if (!flagSnapshot.every((flag): flag is string => typeof flag === "string")) return null;
    return { address, kind, score, flags: flagSnapshot, maxDrawdown, annualisedVol, cloneOf };
  } catch {
    // One malformed row, including a throwing getter or proxy, cannot break selection.
    return null;
  }
};

const compareNullableMetric = (left: number | null, right: number | null): number =>
  left === null ? (right === null ? 0 : 1) : right === null ? -1 : left - right;

const compareText = (left: string, right: string): number => left < right ? -1 : left > right ? 1 : 0;

export const shortlist = (finalists: FinalistLike[], intent: StrategyIntent, effectiveMaxSources: number): string[] => {
  if (!Number.isSafeInteger(effectiveMaxSources) || effectiveMaxSources < 5 || effectiveMaxSources > 25) {
    throw new RangeError("effectiveMaxSources must be an integer from 5 to 25");
  }
  intent = parseStrategyIntent(intent);
  const excluded = new Set(["overflow", "ruin", "low-coverage", "no-intervals"]);
  const compareScore = (a: FinalistLike & { score: number }, b: FinalistLike & { score: number }): number =>
    b.score - a.score || compareAddress(a, b) ||
    compareNullableMetric(a.maxDrawdown, b.maxDrawdown) ||
    compareNullableMetric(a.annualisedVol, b.annualisedVol) ||
    compareText(a.kind, b.kind) || compareText([...a.flags].sort().join(","), [...b.flags].sort().join(",")) ||
    Number(a.cloneOf) - Number(b.cloneOf);
  const candidates = finalists.map(snapshotFinalist).filter((candidate): candidate is FinalistLike & { score: number } =>
    candidate !== null && candidate.score !== null && !candidate.flags.some((flag) => excluded.has(flag)) &&
    !(intent.avoidClones && candidate.cloneOf === true),
  );
  // Collapse eligible snapshots before the score window or risk-metric ranking.
  const unique = new Map<string, FinalistLike & { score: number }>();
  for (const candidate of candidates) {
    const key = candidate.address.toLowerCase();
    const previous = unique.get(key);
    if (!previous || compareScore(candidate, previous) < 0) unique.set(key, candidate);
  }
  const ranked = [...unique.values()].sort(compareScore);
  if (intent.riskStyle === "aggressive") {
    return ranked.slice(0, effectiveMaxSources).map((candidate) => candidate.address);
  }
  const metric = intent.riskStyle === "balanced" ? "maxDrawdown" : "annualisedVol";
  return ranked.slice(0, 2 * effectiveMaxSources).sort((a, b) => {
    return compareNullableMetric(a[metric], b[metric]) || compareScore(a, b);
  }).slice(0, effectiveMaxSources).map((candidate) => candidate.address);
};

import type { Policy } from "./src/contracts";
import { validateRuntimePolicy } from "./src/policy-runtime";

/** The bounded, user-facing preferences an LLM may extract. Never contains addresses, weights, or policy fields. */
export type StrategyIntent = {
  riskStyle: "aggressive" | "balanced" | "conservative";
  maxSources: number;
  diversification: "low" | "medium" | "high";
  leverageComfort: "low" | "medium" | "high";
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
    required: ["riskStyle", "maxSources", "diversification", "leverageComfort", "requestedLeverage", "avoidClones", "horizon", "clarify", "reply"],
    properties: {
      riskStyle: { type: "string", enum: ["aggressive", "balanced", "conservative"] },
      maxSources: { type: "integer", minimum: 5, maximum: 15 },
      diversification: { type: "string", enum: ["low", "medium", "high"] },
      leverageComfort: { type: "string", enum: ["low", "medium", "high"] },
      requestedLeverage: { type: ["number", "null"], exclusiveMinimum: 0, maximum: 1000 },
      avoidClones: { type: "boolean" },
      horizon: { type: "string", enum: ["short", "medium"] },
      clarify: { type: ["string", "null"], maxLength: 200 },
      reply: { type: "string", minLength: 1, maxLength: 400 },
    },
  },
} as const;

const INTENT_KEYS = Object.keys(STRATEGY_INTENT_JSON_SCHEMA.schema.properties) as (keyof StrategyIntent)[];
const INTENT_KEY_SET = new Set<string>(INTENT_KEYS);
const HIDDEN_OR_BIDI = /[\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]/u;
const CONTROL = /[\u0000-\u001f\u007f]/u;
const REPLY_CONTROL = /[\u0000-\u0009\u000b-\u001f\u007f]/u;

type SnapshotResult = { value: Record<string, unknown> | null; problems: string[] };

/** Reads own data descriptors into a new object, avoiding repeated getter/proxy property reads. */
function snapshotPlainRecord(input: unknown, expectedKeys?: Set<string>): SnapshotResult {
  const problems: string[] = [];
  try {
    if (input === null || typeof input !== "object" || Array.isArray(input)) {
      return { value: null, problems: ["value must be a plain object"] };
    }
    const prototype = Object.getPrototypeOf(input);
    if (prototype !== Object.prototype && prototype !== null) return { value: null, problems: ["value must be a plain object"] };
    const keys = Reflect.ownKeys(input);
    const value: Record<string, unknown> = {};
    for (const key of keys) {
      if (typeof key !== "string" || expectedKeys && !expectedKeys.has(key)) {
        problems.push(`unexpected key: ${String(key)}`);
        continue;
      }
      const descriptor = Object.getOwnPropertyDescriptor(input, key);
      if (!descriptor) {
        problems.push(`unreadable key: ${key}`);
      } else if (!Object.hasOwn(descriptor, "value")) {
        problems.push(`accessor property: ${key}`);
      } else {
        value[key] = descriptor.value;
      }
    }
    return { value, problems };
  } catch {
    return { value: null, problems: ["value could not be inspected safely"] };
  }
}

function validateIntentFields(value: Record<string, unknown>, initialProblems: string[]): string[] {
  const problems = [...initialProblems];
  for (const key of INTENT_KEYS) if (!Object.hasOwn(value, key)) problems.push(`missing key: ${key}`);
  const oneOf = (key: keyof StrategyIntent, choices: readonly string[]) => {
    if (typeof value[key] !== "string" || !choices.includes(value[key] as string)) problems.push(`${key} has an unsupported value`);
  };
  oneOf("riskStyle", ["aggressive", "balanced", "conservative"]);
  oneOf("diversification", ["low", "medium", "high"]);
  oneOf("leverageComfort", ["low", "medium", "high"]);
  oneOf("horizon", ["short", "medium"]);
  if (typeof value.maxSources !== "number" || !Number.isSafeInteger(value.maxSources) || value.maxSources < 5 || value.maxSources > 15) {
    problems.push("maxSources must be an integer from 5 to 15");
  }
  if (value.requestedLeverage !== null && (typeof value.requestedLeverage !== "number" || !Number.isFinite(value.requestedLeverage) || value.requestedLeverage <= 0 || value.requestedLeverage > 1000)) {
    problems.push("requestedLeverage must be null or a finite number in (0, 1000]");
  }
  if (typeof value.avoidClones !== "boolean") problems.push("avoidClones must be a boolean");
  if (value.clarify !== null && (typeof value.clarify !== "string" || value.clarify.length > 200)) problems.push("clarify must be null or at most 200 characters");
  if (typeof value.reply !== "string" || value.reply.length < 1 || value.reply.length > 400) problems.push("reply must contain 1 to 400 characters");
  for (const key of ["clarify", "reply"] as const) {
    const text = value[key];
    if (typeof text !== "string") continue;
    if (HIDDEN_OR_BIDI.test(text)) problems.push(`${key} contains hidden or bidirectional characters`);
    if ((key === "reply" ? REPLY_CONTROL : CONTROL).test(text)) problems.push(`${key} contains control characters`);
  }
  return problems;
}

export function checkStrategyIntent(input: unknown): string[] {
  const snapshot = snapshotPlainRecord(input, INTENT_KEY_SET);
  if (snapshot.value === null) return snapshot.problems;
  return validateIntentFields(snapshot.value, snapshot.problems);
}

export function parseStrategyIntent(input: unknown): StrategyIntent {
  const snapshot = snapshotPlainRecord(input, INTENT_KEY_SET);
  if (snapshot.value === null) throw new TypeError(`invalid strategy intent: ${snapshot.problems[0]}`);
  const problems = validateIntentFields(snapshot.value, snapshot.problems);
  if (problems.length) throw new TypeError(`invalid strategy intent: ${problems[0]}`);
  return Object.freeze(snapshot.value) as StrategyIntent;
}

export type PolicyChange = { field: keyof Policy; from: string | number; to: string | number };
export type PolicyClamp = { field: "maxGrossLeverage"; requested: number; applied: number };
export type StrategyPreview = {
  policy: Policy;
  maxSources: number;
  requiredSources: number;
  changes: PolicyChange[];
  clamps: PolicyClamp[];
  approvalRequired: true;
  executionMode: "SIMULATION_PREVIEW";
};

const POLICY_KEYS = new Set([
  "bucket", "mode", "capitalUsd", "minOrderUsd", "minExecutableTargets", "maxSourceWeight", "maxGrossLeverage", "cashBuffer",
  "maxPairCorrelation", "maxExposureOverlap", "minHistoryDays", "maxFrameAgeMs", "minExecutionFit", "riskRejectThreshold",
  "riskWatchThreshold", "minConfidence", "redTeamRebuildThreshold", "redTeamExcludeThreshold",
]);

/** Exact decimal-rational ceil prevents floating-point boundary errors in the feasibility check. */
function fraction(value: number): [bigint, bigint] {
  const match = /^(-?)(\d+)(?:\.(\d*))?(?:e([+-]?\d+))?$/i.exec(value.toString());
  if (!match) throw new Error("policy values must be finite decimals");
  const sign = match[1] === "-" ? -1n : 1n;
  const digits = `${match[2]}${match[3] ?? ""}`;
  const exponent = Number(match[4] ?? 0) - (match[3]?.length ?? 0);
  const scale = 10n ** BigInt(Math.abs(exponent));
  const numerator = sign * BigInt(digits);
  return exponent >= 0 ? [numerator * scale, 1n] : [numerator, scale];
}

function requiredSourceCount(maxSourceWeight: number, cashBuffer: number): number {
  const [weightN, weightD] = fraction(maxSourceWeight);
  const [cashN, cashD] = fraction(cashBuffer);
  const numerator = (cashD - cashN) * weightD;
  const denominator = cashD * weightN;
  if (denominator <= 0n || numerator < 0n) throw new Error("policy cannot produce a source feasibility bound");
  return Number((numerator + denominator - 1n) / denominator);
}

function snapshotPolicy(input: unknown): Policy {
  const snapshot = snapshotPlainRecord(input, POLICY_KEYS);
  if (snapshot.value === null || snapshot.problems.length) throw new TypeError(`invalid base policy: ${snapshot.problems[0] ?? "unknown policy field"}`);
  for (const key of POLICY_KEYS) {
    if (!Object.hasOwn(snapshot.value, key)) throw new TypeError(`invalid base policy: missing ${key}`);
  }
  // The runtime policy schema is the existing contract authority; do not duplicate it here.
  try {
    validateRuntimePolicy(snapshot.value);
  } catch (error) {
    throw new TypeError(`invalid base policy: ${error instanceof Error ? error.message : "policy schema validation failed"}`);
  }
  return { ...snapshot.value } as unknown as Policy;
}

const bucketRank: Record<Policy["bucket"], number> = { CONSERVATIVE: 0, BALANCED: 1, AGGRESSIVE: 2 };

/** Compiles intent to a bounded preview. It can never produce a LIVE policy. */
export function intentToPreview(input: unknown, baseInput: unknown): StrategyPreview {
  const intent = parseStrategyIntent(input);
  if (intent.clarify !== null) throw new Error("strategy intent needs clarification before a preview can be compiled");
  const base = snapshotPolicy(baseInput);
  const policy: Policy = { ...base, mode: "SIMULATION" };
  const requestedBucket = intent.riskStyle.toUpperCase() as Policy["bucket"];
  policy.bucket = bucketRank[requestedBucket] < bucketRank[base.bucket] ? requestedBucket : base.bucket;

  if (intent.riskStyle === "balanced") {
    policy.maxSourceWeight = Math.min(policy.maxSourceWeight, 0.2);
    policy.maxGrossLeverage = Math.min(policy.maxGrossLeverage, 2.5);
    policy.cashBuffer = Math.max(policy.cashBuffer, 0.2);
  } else if (intent.riskStyle === "conservative") {
    policy.maxSourceWeight = Math.min(policy.maxSourceWeight, 0.12);
    policy.maxGrossLeverage = Math.min(policy.maxGrossLeverage, 1);
    policy.cashBuffer = Math.max(policy.cashBuffer, 0.35);
  }

  if (intent.diversification === "medium") {
    policy.maxPairCorrelation = Math.min(policy.maxPairCorrelation, 0.7);
    policy.maxExposureOverlap = Math.min(policy.maxExposureOverlap, 0.4);
  } else if (intent.diversification === "high") {
    policy.maxPairCorrelation = Math.min(policy.maxPairCorrelation, 0.55);
    policy.maxExposureOverlap = Math.min(policy.maxExposureOverlap, 0.3);
  }
  if (intent.leverageComfort === "medium") policy.maxGrossLeverage = Math.min(policy.maxGrossLeverage, 2.5);
  if (intent.leverageComfort === "low") policy.maxGrossLeverage = Math.min(policy.maxGrossLeverage, 1.5);

  const clamps: PolicyClamp[] = [];
  if (intent.requestedLeverage !== null) {
    if (intent.requestedLeverage > policy.maxGrossLeverage) clamps.push({ field: "maxGrossLeverage", requested: intent.requestedLeverage, applied: policy.maxGrossLeverage });
    policy.maxGrossLeverage = Math.min(policy.maxGrossLeverage, intent.requestedLeverage);
  }

  const requiredSources = requiredSourceCount(policy.maxSourceWeight, policy.cashBuffer);
  if (requiredSources > intent.maxSources) {
    throw new RangeError(`infeasible intent: risk limits require ${requiredSources} sources but the requested maximum is ${intent.maxSources}`);
  }
  validateRuntimePolicy(policy);
  const changes = (Object.keys(base) as (keyof Policy)[])
    .filter((field) => base[field] !== policy[field])
    .map((field) => ({ field, from: base[field] as string | number, to: policy[field] as string | number }));

  return {
    policy,
    maxSources: intent.maxSources,
    requiredSources,
    changes,
    clamps,
    approvalRequired: true,
    executionMode: "SIMULATION_PREVIEW",
  };
}

export type FinalistLike = {
  address: string;
  kind: string;
  score: number | null;
  flags: readonly string[];
  maxDrawdown: number | null;
  realizedVol: number | null;
  /** null means no verified clone determination is available. */
  cloneOf: boolean | null;
};

function snapshotFlags(input: unknown): string[] | null {
  try {
    if (!Array.isArray(input)) return null;
    const length = input.length;
    if (!Number.isSafeInteger(length) || length < 0) return null;
    const result: string[] = [];
    for (let index = 0; index < length; index++) {
      const descriptor = Object.getOwnPropertyDescriptor(input, String(index));
      if (!descriptor || !Object.hasOwn(descriptor, "value") || typeof descriptor.value !== "string") return null;
      result.push(descriptor.value);
    }
    return result;
  } catch {
    return null;
  }
}

function snapshotFinalist(input: unknown): FinalistLike | null {
  const fields = new Set(["address", "kind", "score", "flags", "maxDrawdown", "realizedVol", "cloneOf"]);
  const snapshot = snapshotPlainRecord(input, fields);
  if (!snapshot.value || snapshot.problems.length) return null;
  const row = snapshot.value;
  const flags = snapshotFlags(row.flags);
  if (typeof row.address !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(row.address) || typeof row.kind !== "string" || !row.kind ||
      !(row.score === null || typeof row.score === "number" && Number.isFinite(row.score)) || !flags ||
      !(row.maxDrawdown === null || typeof row.maxDrawdown === "number" && Number.isFinite(row.maxDrawdown)) ||
      !(row.realizedVol === null || typeof row.realizedVol === "number" && Number.isFinite(row.realizedVol)) ||
      !(typeof row.cloneOf === "boolean" || row.cloneOf === null)) return null;
  return { address: row.address, kind: row.kind, score: row.score as number | null, flags, maxDrawdown: row.maxDrawdown as number | null, realizedVol: row.realizedVol as number | null, cloneOf: row.cloneOf as boolean | null };
}

const EXCLUDED_FLAGS = new Set(["overflow", "ruin", "low-coverage", "no-intervals"]);
const compareText = (left: string, right: string): number => left < right ? -1 : left > right ? 1 : 0;
const compareNullable = (left: number | null, right: number | null): number => left === null ? (right === null ? 0 : 1) : right === null ? -1 : left < right ? -1 : left > right ? 1 : 0;

function compareScore(left: FinalistLike & { score: number }, right: FinalistLike & { score: number }): number {
  const addressOrder = compareText(left.address.toLowerCase(), right.address.toLowerCase()) || compareText(left.address, right.address);
  const flagsOrder = compareText([...left.flags].sort().join("\u0000"), [...right.flags].sort().join("\u0000"));
  const cloneRank = (value: boolean | null) => value === false ? 0 : value === null ? 1 : 2;
  return compareNullable(right.score, left.score) || addressOrder || compareNullable(left.maxDrawdown, right.maxDrawdown) ||
    compareNullable(left.realizedVol, right.realizedVol) || compareText(left.kind, right.kind) || flagsOrder || cloneRank(left.cloneOf) - cloneRank(right.cloneOf);
}

/** Deterministic preview shortlist over already-scored candidates; it cannot create or place orders. */
export function shortlist(finalistsInput: unknown, intentInput: unknown, maxSources: number): string[] {
  const intent = parseStrategyIntent(intentInput);
  if (intent.clarify !== null) throw new Error("strategy intent needs clarification before finalists can be shortlisted");
  if (!Number.isSafeInteger(maxSources) || maxSources < 5 || maxSources > intent.maxSources) throw new RangeError("maxSources must be an integer from 5 to the intent maximum");
  if (!Array.isArray(finalistsInput)) throw new TypeError("finalists must be an array");
  const rows: unknown[] = [];
  try {
    for (let index = 0; index < finalistsInput.length; index++) {
      const descriptor = Object.getOwnPropertyDescriptor(finalistsInput, String(index));
      if (!descriptor || !Object.hasOwn(descriptor, "value")) continue;
      rows.push(descriptor.value);
    }
  } catch {
    return [];
  }

  const candidates = rows.map(snapshotFinalist).filter((row): row is FinalistLike & { score: number } =>
    row !== null && row.score !== null && !row.flags.some((flag) => EXCLUDED_FLAGS.has(flag)) && !(intent.avoidClones && row.cloneOf !== false),
  );
  const unique = new Map<string, FinalistLike & { score: number }>();
  for (const candidate of candidates) {
    const address = candidate.address.toLowerCase();
    const previous = unique.get(address);
    if (!previous || compareScore(candidate, previous) < 0) unique.set(address, candidate);
  }
  const ranked = [...unique.values()].sort(compareScore);
  if (intent.riskStyle === "aggressive") return ranked.slice(0, maxSources).map((row) => row.address);
  const riskField = intent.riskStyle === "balanced" ? "maxDrawdown" : "realizedVol";
  return ranked.slice(0, maxSources * 2).sort((left, right) => compareNullable(left[riskField], right[riskField]) || compareScore(left, right))
    .slice(0, maxSources).map((row) => row.address);
}

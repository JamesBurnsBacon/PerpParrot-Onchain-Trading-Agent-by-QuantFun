import type { StrategyIntent } from "../../shared/parrot-intent";

export type Clamp = { field: string; requested: number; applied: number };
export type ChatResponse = {
  ok: true;
  reply: string;
  clarify: string | null;
  intent: StrategyIntent;
  policy: {
    liveEligible: boolean;
    effectiveMaxSources: number;
    changes: { field: string; from: number | string; to: number | string }[];
    clamps: Clamp[];
    notes: string[];
  };
  shortlist: { addresses: string[]; dataSource: "live" | "sample" };
  model: string;
  latencyMs: number;
};
export type PreviewResponse = {
  ok: true;
  requestId: string;
  preview: {
    version: "1";
    liveEligible: boolean;
    paperOnly: boolean;
    weighting: string;
    policy: Record<string, unknown>;
    sources: { address: string; weightUnits: number; ceilingUnits: number }[];
    cashUnits: number;
    notes: string[];
    previewHash: string;
  };
};
export const errorCodes = ["disabled", "bad_request", "too_large", "rate_limited", "budget", "model_unavailable", "invalid_model_output", "infeasible", "too_few_sources"] as const;
export type ApiError = { ok: false; code: typeof errorCodes[number]; reply: string; retryAfterSec?: number };

const record = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): v is string => typeof v === "string";
const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const nonnegative = (v: unknown): v is number => finite(v) && v >= 0;
const integer = (v: unknown): v is number => nonnegative(v) && Number.isSafeInteger(v);
const strings = (v: unknown): v is string[] => Array.isArray(v) && v.every(str);
const nullableString = (v: unknown): v is string | null => v === null || str(v);
const address = (v: unknown): v is string => str(v) && /^0x[0-9a-fA-F]{40}$/.test(v);
// Sample fixtures use ids like "addr-21"; live data uses 0x addresses. Rendered as text only.
const walletId = (v: unknown): v is string => str(v) && /^[\w.:-]{1,66}$/.test(v);
const oneOf = (v: unknown, choices: string[]) => str(v) && choices.includes(v);
const scalar = (v: unknown) => str(v) || finite(v);

const isIntent = (v: unknown): v is StrategyIntent => record(v) &&
  oneOf(v.riskStyle, ["aggressive", "balanced", "conservative"]) &&
  integer(v.maxSources) && v.maxSources >= 5 && v.maxSources <= 25 &&
  oneOf(v.diversification, ["low", "med", "high"]) && oneOf(v.leverageComfort, ["low", "med", "high"]) &&
  (v.requestedLeverage === null || (finite(v.requestedLeverage) && v.requestedLeverage > 0 && v.requestedLeverage <= 1000)) &&
  typeof v.avoidClones === "boolean" && oneOf(v.horizon, ["short", "medium"]) &&
  nullableString(v.clarify) && (v.clarify === null || v.clarify.length <= 200) &&
  str(v.reply) && v.reply.length > 0 && v.reply.length <= 400;

export function isChatResponse(v: unknown): v is ChatResponse {
  if (!record(v) || v.ok !== true || !str(v.reply) || !nullableString(v.clarify) || !isIntent(v.intent) ||
      !str(v.model) || !nonnegative(v.latencyMs) || !record(v.policy) || !record(v.shortlist)) return false;
  const p = v.policy;
  return typeof p.liveEligible === "boolean" && integer(p.effectiveMaxSources) && p.effectiveMaxSources >= 5 && p.effectiveMaxSources <= 25 &&
    Array.isArray(p.changes) && p.changes.every(c => record(c) && str(c.field) && scalar(c.from) && scalar(c.to)) &&
    Array.isArray(p.clamps) && p.clamps.every(c => record(c) && str(c.field) && finite(c.requested) && finite(c.applied)) &&
    strings(p.notes) && Array.isArray(v.shortlist.addresses) && v.shortlist.addresses.every(walletId) &&
    oneOf(v.shortlist.dataSource, ["live", "sample"]);
}

export function isPreviewResponse(v: unknown): v is PreviewResponse {
  if (!record(v) || v.ok !== true || !str(v.requestId) || !v.requestId || !record(v.preview)) return false;
  const p = v.preview;
  return p.version === "1" && typeof p.liveEligible === "boolean" && typeof p.paperOnly === "boolean" &&
    str(p.weighting) && record(p.policy) && integer(p.cashUnits) && strings(p.notes) && str(p.previewHash) && p.previewHash.length > 0 &&
    Array.isArray(p.sources) && p.sources.every(s => record(s) && walletId(s.address) && integer(s.weightUnits) && integer(s.ceilingUnits));
}

export function isApiError(v: unknown): v is ApiError {
  return record(v) && v.ok === false && str(v.code) && errorCodes.some(c => c === v.code) && str(v.reply) &&
    (v.retryAfterSec === undefined || nonnegative(v.retryAfterSec));
}

export const shortenAddress = (value: string): string => address(value) ? `${value.slice(0, 6)}...${value.slice(-4)}` : value;

export function describeError(code: string, retryAfterSec?: number): string {
  const retry = retryAfterSec !== undefined && Number.isFinite(retryAfterSec) && retryAfterSec >= 0
    ? `Try again in ${Math.ceil(retryAfterSec)} seconds.` : "Try again shortly.";
  switch (code) {
    case "disabled": return "The parrot is resting: chat is switched off";
    case "rate_limited": return `Too many requests; ${retry[0].toLowerCase()}${retry.slice(1)}`;
    case "budget": return `I've used my chat allowance for now; ${retry[0].toLowerCase()}${retry.slice(1)}`;
    case "bad_request": return "Give me a short description of the strategy you'd like to explore.";
    case "too_large": return "That's a beakful! Keep your message to 500 characters.";
    case "model_unavailable": return "The model is unavailable; please try again shortly.";
    case "invalid_model_output": return "My answer didn't pass the code checks; please try again.";
    case "infeasible": return "Those preferences don't fit the policy limits. Try more sources or less leverage.";
    case "too_few_sources": return "There aren't enough eligible wallets for that mix. Let's try a broader selection.";
    case "network": return "I can't reach the nest; check your connection or play the cached demo.";
    default: return "My answer couldn't be checked. Please try again.";
  }
}

export function intentChips(intent: StrategyIntent): string[] {
  const levels = { low: "Low", med: "Medium", high: "High" };
  return [intent.riskStyle[0].toUpperCase() + intent.riskStyle.slice(1), `Up to ${intent.maxSources} sources`,
    `${levels[intent.diversification]} diversification`, `${levels[intent.leverageComfort]} leverage comfort`,
    intent.avoidClones ? "Avoid clones" : "Clones allowed"];
}

export function clampBanner(clamps: Clamp[]): string | null {
  if (!clamps.length) return null;
  return clamps.map(c => `Capped by code: you asked ${c.requested}x, the policy allows ${c.applied}x`).join(". ");
}

// Milliseconds relative to the start. Zero duration is the reduced-motion schedule.
export function typewriterFrames(text: string, perChar: number): { atMs: number; text: string }[] {
  if (!Number.isFinite(perChar) || perChar <= 0) return [{ atMs: 0, text }];
  let written = "";
  return [{ atMs: 0, text: "" }, ...Array.from(text, (char, i) => ({ atMs: (i + 1) * perChar, text: (written += char) }))];
}

export function holdProgress(startMs: number, nowMs: number, holdMs: number): number {
  if (![startMs, nowMs, holdMs].every(Number.isFinite) || holdMs <= 0) return 0;
  return Math.max(0, Math.min(1, (nowMs - startMs) / holdMs));
}


export function isPointerOutside(x: number, y: number, bounds: { left: number; right: number; top: number; bottom: number }): boolean {
  return !Number.isFinite(x) || !Number.isFinite(y) || x < bounds.left || x > bounds.right || y < bounds.top || y > bounds.bottom;
}


export function canContinueHold(startedFor: unknown, currentTarget: unknown, disabled: boolean): boolean {
  return !disabled && Object.is(startedFor, currentTarget);
}

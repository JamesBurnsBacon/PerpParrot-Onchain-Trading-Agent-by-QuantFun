// Response guards and interaction helpers used by Parrot components and hooks.
// Reject non-simulation previews; display data must never authorize trading.
import type { LiveContext } from "../../shared/live-context";
import { isLiveContext } from "./parrot-context";
import { WALLET_TAGS, isSelectionReason, type WalletEvidence, type WalletChanges } from "../../shared/wallet-evidence";
import type { StrategyIntent } from "../../shared/strategy-intent";

export type ChatResponse = {
  ok: true;
  evidence?: WalletEvidence[];
  context?: LiveContext;
  changes?: WalletChanges;
  reply: string;
  clarify: string | null;
  intent: StrategyIntent;
  policy: {
    maxSources: number;
    // Empty arrays are retained for response compatibility; selection never rewrites policy.
    changes: [];
    clamps: [];
  };
  shortlist: { addresses: string[]; dataSource: "live" | "sample" };
  model: string;
  latencyMs: number;
};
export type PreviewResponse = {
  ok: true;
  requestId: string;
  preview: {
    approvalRequired: true;
    version: "1";
    weighting: string;
    policy: Record<string, unknown>;
    sources: { address: string; weightUnits: number; ceilingUnits: number }[];
    cashUnits: number;
    previewHash: string;
  };
};
const errorCodes = ["disabled", "bad_request", "too_large", "rate_limited", "budget", "model_unavailable", "invalid_model_output", "infeasible", "too_few_sources"] as const;
export type ApiError = { ok: false; code: typeof errorCodes[number]; reply: string; retryAfterSec?: number };

const record = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): v is string => typeof v === "string";
const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const nonnegative = (v: unknown): v is number => finite(v) && v >= 0;
const integer = (v: unknown): v is number => nonnegative(v) && Number.isSafeInteger(v);
const nullableString = (v: unknown): v is string | null => v === null || str(v);
const address = (v: unknown): v is string => str(v) && /^0x[0-9a-fA-F]{40}$/.test(v);
// Synthetic and live candidates share the same address contract.
const walletId = address;
const oneOf = (v: unknown, choices: string[]) => str(v) && choices.includes(v);

const isIntent = (v: unknown): v is StrategyIntent => record(v) &&
  oneOf(v.riskStyle, ["aggressive", "balanced", "conservative"]) &&
  integer(v.maxSources) && v.maxSources >= 5 && v.maxSources <= 25 &&
  oneOf(v.diversification, ["low", "medium", "high"]) && oneOf(v.leverageComfort, ["low", "medium", "high"]) &&
  (v.requestedLeverage === null || (finite(v.requestedLeverage) && v.requestedLeverage > 0 && v.requestedLeverage <= 1000)) &&
  typeof v.avoidClones === "boolean" && oneOf(v.horizon, ["short", "medium"]) &&
  nullableString(v.clarify) && (v.clarify === null || v.clarify.length <= 200) &&
  str(v.reply) && v.reply.length > 0 && v.reply.length <= 400;

export const isWalletEvidence = (v: unknown): v is WalletEvidence[] => Array.isArray(v) && v.length <= 25 &&
  new Set(v.map(e => record(e) ? e.address : null)).size === v.length && v.every(e => record(e) &&
    Object.keys(e).every(k => ["address", "rank", "maxDrawdown", "realizedVol", "tags", "periodReturn", "sharpe"].includes(k)) && walletId(e.address) && integer(e.rank) && e.rank > 0 &&
    (e.maxDrawdown === null || (nonnegative(e.maxDrawdown) && e.maxDrawdown <= 1)) &&
    (e.realizedVol === null || nonnegative(e.realizedVol)) &&
    [e.periodReturn, e.sharpe].every(n => n === undefined || n === null || finite(n)) && Array.isArray(e.tags) && e.tags.length <= 6 &&
    e.tags.every(t => typeof t === "string" && (WALLET_TAGS as readonly string[]).includes(t)));
const isWalletChanges = (v: unknown): v is WalletChanges => record(v) && Object.keys(v).length === 2 &&
  [v.added, v.removed].every(side => Array.isArray(side) && side.length <= 25 &&
    new Set(side.map(e => record(e) ? e.address : null)).size === side.length && side.every(e => record(e) &&
      Object.keys(e).length === 2 && walletId(e.address) && isSelectionReason(e.reason)));

type ChatClarification = Pick<ChatResponse, "ok" | "reply" | "intent" | "model" | "latencyMs"> & { clarify: string };
export function isChatClarification(v: unknown): v is ChatClarification {
  return record(v) && v.ok === true && str(v.reply) && str(v.clarify) && isIntent(v.intent) &&
    v.intent.clarify === v.clarify && str(v.model) && nonnegative(v.latencyMs) &&
    !("policy" in v) && !("shortlist" in v);
}

export function isChatResponse(v: unknown): v is ChatResponse {
  if (!record(v) || v.ok !== true || !str(v.reply) || v.clarify !== null || !isIntent(v.intent) || v.intent.clarify !== null ||
      !str(v.model) || !nonnegative(v.latencyMs) || !record(v.policy) || !record(v.shortlist) || !Array.isArray(v.shortlist.addresses)) return false;
  if (v.context !== undefined && !isLiveContext(v.context)) return false;
  if (v.evidence !== undefined && (!isWalletEvidence(v.evidence) || JSON.stringify(v.evidence.map(e => e.address)) !== JSON.stringify(v.shortlist.addresses))) return false;
  if (v.changes !== undefined && (!isWalletChanges(v.changes) || v.changes.added.some(e => !(v.shortlist as {addresses: string[]}).addresses.includes(e.address)) || v.changes.removed.some(e => (v.shortlist as {addresses: string[]}).addresses.includes(e.address)))) return false;
  const p = v.policy;
  return Object.keys(p).every(k => ["changes", "clamps", "maxSources"].includes(k)) && integer(p.maxSources) && p.maxSources >= 5 && p.maxSources <= 25 && p.maxSources === v.intent.maxSources &&
    Array.isArray(p.changes) && p.changes.length === 0 &&
    Array.isArray(p.clamps) && p.clamps.length === 0 &&
    Array.isArray(v.shortlist.addresses) && v.shortlist.addresses.length <= p.maxSources && new Set(v.shortlist.addresses).size === v.shortlist.addresses.length && v.shortlist.addresses.every(walletId) &&
    oneOf(v.shortlist.dataSource, ["live", "sample"]);
}

export function isPreviewResponse(v: unknown): v is PreviewResponse {
  if (!record(v) || v.ok !== true || !str(v.requestId) || !v.requestId || !record(v.preview)) return false;
  const p = v.preview;
  return p.approvalRequired === true && p.version === "1" &&
    str(p.weighting) && record(p.policy) && p.policy.mode === "SIMULATION" && integer(p.cashUnits) && str(p.previewHash) && p.previewHash.length > 0 &&
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
    case "infeasible": return "That preview cannot be saved with the base policy. An operator must review it.";
    case "too_few_sources": return "There aren't enough eligible wallets for that mix. Let's try a broader selection.";
    case "network": return "I can't reach the nest; check your connection or play the cached demo.";
    default: return "My answer couldn't be checked. Please try again.";
  }
}

export function intentChips(intent: StrategyIntent): string[] {
  const levels = { low: "Low", medium: "Medium", high: "High" };
  return [intent.riskStyle[0].toUpperCase() + intent.riskStyle.slice(1), `Up to ${intent.maxSources} sources`,
    `${levels[intent.diversification]} diversification`, `${levels[intent.leverageComfort]} leverage comfort`,
    intent.avoidClones ? "Avoid clones" : "Clones allowed"];
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

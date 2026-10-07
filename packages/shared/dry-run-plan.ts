// The Parrot's dry-run order sketch: what copying a visitor's shortlist would look like, never sent anywhere.
// Shared by the backend that builds it and the dashboard that checks and shows it.

export type DryRunOrder = { asset: string; isBuy: boolean; size: string; notionalUsd: number; markPx: number };
export type DryRunSkipReason = "UNKNOWN_MARKET" | "NOT_TRADABLE" | "BELOW_MIN_ORDER" | "BELOW_EQUITY_BAND" | "SIZE_ROUNDS_TO_ZERO";
export type DryRunSkip = { asset: string; reason: DryRunSkipReason; targetUsd: number };
export type DryRunPlan = {
  asOfMs: number;
  // The hypothetical account the sketch is sized for: flat, at this equity.
  equityUsd: number;
  // 1 = none; below 1 the margin rule scaled every target down pro rata.
  marginScale: number;
  grossUsd: number;
  orders: DryRunOrder[];
  skipped: DryRunSkip[];
};

const record = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
const num = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const SKIPS: readonly string[] = ["UNKNOWN_MARKET", "NOT_TRADABLE", "BELOW_MIN_ORDER", "BELOW_EQUITY_BAND", "SIZE_ROUNDS_TO_ZERO"];

export const isDryRunPlan = (v: unknown): v is DryRunPlan => record(v) && num(v.asOfMs) && num(v.equityUsd) && num(v.marginScale) && num(v.grossUsd) &&
  Array.isArray(v.orders) && v.orders.length <= 40 && v.orders.every(o => record(o) && typeof o.asset === "string" && typeof o.isBuy === "boolean" &&
    typeof o.size === "string" && num(o.notionalUsd) && num(o.markPx)) &&
  Array.isArray(v.skipped) && v.skipped.length <= 80 && v.skipped.every(s => record(s) && typeof s.asset === "string" && SKIPS.includes(s.reason as string) && num(s.targetUsd));

// Read-only dry-run order sketch for a visitor shortlist: the shortlist's wallets copied at equal weights onto a flat,
// hypothetical account at current marks. Reads Hyperliquid's public API only; signs nothing, sends nothing, writes nothing.
// It is a sketch, not the executor's plan: production weights, leverage normalization, current positions and the
// close-confirmation delay are not part of it.
import type { Policy } from "../../../shared/src/contracts";
import { targetsFromSnapshot } from "../../../shared/copy";
import type { DryRunOrder, DryRunPlan, DryRunSkip } from "../../../shared/dry-run-plan";
import type { FrozenConfiguration } from "../../../shared/frozen";
import { legSkip } from "../../../shared/rebalance";
import { hlReader, metaAndAssetCtxs, type HlReader } from "../hyperliquid";
import { buildSnapshot } from "../snapshot";

// The live account's size (README: 5 HYPE, about $470); the sketch is sized for it.
export const PLAN_EQUITY_USD = 470;
const BANDS = { minOrderUsd: 10, driftFraction: 0.1, equityBandFraction: 0.005 };
const MARGIN_CAP = 0.95;
const MIN_TRADABLE_OI_USD = 15_000_000;
const DEXES = ["", "xyz"] as const;

export type PlanMarket = { markPx: number; szDecimals: number; maxLeverage: number; tradable: boolean };
type Meta = { universe: { name: string; szDecimals?: number; maxLeverage: number; isDelisted?: boolean; onlyIsolated?: boolean; marginMode?: string }[]; collateralToken?: number };
type Ctx = { markPx?: string | null; openInterest?: string };

export const loadPlanMarkets = async (): Promise<Map<string, PlanMarket>> => {
  const markets = new Map<string, PlanMarket>();
  for (const dex of DEXES) {
    const [meta, ctxs] = (await metaAndAssetCtxs(dex)) as unknown as [Meta, Ctx[]];
    meta.universe.forEach((u, i) => {
      const markPx = Number(ctxs[i]?.markPx);
      if (u.isDelisted || !(markPx > 0) || !Number.isInteger(u.szDecimals)) return;
      const cross = !u.onlyIsolated && u.marginMode !== "noCross" && u.marginMode !== "strictIsolated";
      const usdc = (meta.collateralToken ?? 0) === 0;
      markets.set(u.name, { markPx, szDecimals: u.szDecimals!, maxLeverage: u.maxLeverage, tradable: cross && usdc && Number(ctxs[i]?.openInterest ?? 0) * markPx >= MIN_TRADABLE_OI_USD });
    });
  }
  return markets;
};

// Pure: signed USD targets for a flat account at `equityUsd`, from the rules the executor's planner applies to a flat account
// (margin cap pro rata, the shared leg rule for the $10 minimum and the equity band, size rounded down to the asset's lot).
export const sketchOrders = (targetsUsd: Map<string, number>, markets: Map<string, PlanMarket>, equityUsd: number, nowMs: number): DryRunPlan => {
  const skipped: DryRunSkip[] = [];
  const usable = new Map<string, number>();
  for (const [asset, targetUsd] of targetsUsd) {
    if (targetUsd === 0) continue;
    const market = markets.get(asset);
    if (!market) { skipped.push({ asset, reason: "UNKNOWN_MARKET", targetUsd }); continue; }
    if (!market.tradable) { skipped.push({ asset, reason: "NOT_TRADABLE", targetUsd }); continue; }
    usable.set(asset, targetUsd);
  }
  const margin = [...usable].reduce((sum, [asset, usd]) => sum + Math.abs(usd) / markets.get(asset)!.maxLeverage, 0);
  const limit = MARGIN_CAP * equityUsd;
  const marginScale = margin > limit && margin > 0 ? limit / margin : 1;
  const orders: DryRunOrder[] = [];
  for (const [asset, raw] of [...usable].sort(([a], [b]) => (a < b ? -1 : 1))) {
    const market = markets.get(asset)!;
    const targetUsd = raw * marginScale;
    const why = legSkip({ targetUsd, currentUsd: 0, equityUsd, closePending: false }, BANDS);
    if (why === "BELOW_MIN_ORDER" || why === "BELOW_EQUITY_BAND") { skipped.push({ asset, reason: why, targetUsd }); continue; }
    const lot = 10 ** market.szDecimals;
    const coins = Math.floor((Math.abs(targetUsd) / market.markPx) * lot) / lot;
    if (!(coins > 0)) { skipped.push({ asset, reason: "SIZE_ROUNDS_TO_ZERO", targetUsd }); continue; }
    // Rounding down to the lot can leave an order under the minimum even though the target was above it.
    if (coins * market.markPx < BANDS.minOrderUsd) { skipped.push({ asset, reason: "BELOW_MIN_ORDER", targetUsd }); continue; }
    orders.push({ asset, isBuy: targetUsd > 0, size: coins.toFixed(market.szDecimals), notionalUsd: Math.round(coins * market.markPx * targetUsd / Math.abs(targetUsd) * 100) / 100, markPx: market.markPx });
  }
  return { asOfMs: nowMs, equityUsd, marginScale, grossUsd: Math.round(orders.reduce((s, o) => s + Math.abs(o.notionalUsd), 0) * 100) / 100, orders, skipped };
};

const ZERO_ADDRESS = `0x${"0".repeat(40)}`;
const ZERO_HASH = `0x${"0".repeat(64)}`;

// A throwaway configuration for the snapshot reader: only the sources and the policy matter, no hash is checked or pinned.
export const sketchConfiguration = (preview: { policy: Policy; sources: { address: string; weightUnits: number; ceilingUnits: number }[]; cashUnits: number }, nowMs: number): FrozenConfiguration => ({
  schemaVersion: "1.0.0", account: ZERO_ADDRESS, chainId: 0, frozenAtMs: nowMs, reviewHash: ZERO_HASH,
  policy: preview.policy as unknown as FrozenConfiguration["policy"], policyHash: ZERO_HASH,
  sources: preview.sources.map((s, i) => ({ candidate: i + 1, sourceAddress: s.address.toLowerCase(), weightUnits: s.weightUnits, ceilingUnits: s.ceilingUnits })),
  cashUnits: preview.cashUnits, configurationHash: ZERO_HASH,
});

export type PlanDeps = { now?: () => number; hl?: HlReader; markets?: () => Promise<Map<string, PlanMarket>> };

export const buildDryRunPlan = async (preview: Parameters<typeof sketchConfiguration>[0], deps: PlanDeps = {}): Promise<DryRunPlan> => {
  const now = deps.now ?? Date.now;
  const markets = await (deps.markets ?? loadPlanMarkets)();
  const eligible = [...markets].filter(([, m]) => m.tradable).map(([name]) => name);
  const snapshot = await buildSnapshot(sketchConfiguration(preview, now()), eligible, Math.floor(now() / 1000), now, deps.hl ?? hlReader);
  const targets = new Map(targetsFromSnapshot(snapshot).map(e => [e.asset, (Number(e.exposureE9) / 1e9) * PLAN_EQUITY_USD]));
  return sketchOrders(targets, markets, PLAN_EQUITY_USD, now());
};

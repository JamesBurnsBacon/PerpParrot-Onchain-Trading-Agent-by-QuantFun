// Targets + live account → orders (README §4.4 drift rule, §4.8 margin rule).
// Pure: no I/O, so every rule here is unit-tested.
import { formatPrice, formatSize } from "@nktkas/hyperliquid/utils";
import { legSkip, type BandConfig, type LegSkip } from "../../shared/rebalance";

export type Market = {
  name: string;
  assetId: number;
  szDecimals: number;
  maxLeverage: number;
  markPx: number;
  // Our own eligibility check (cross margin allowed, OI ≥ the $15M hysteresis floor),
  // independent of the backend's list. False: we may reduce but never open or add.
  tradable: boolean;
};

export type LivePosition = {
  // Signed size in coins (negative = short).
  szi: number;
};

export type LiveAccount = {
  equityUsd: number;
  positions: Map<string, LivePosition>;
};

// The leg rule (shared/rebalance.ts, also the paper books'): $10 minimum, 10% drift, 0.5% of equity.
export type PlanConfig = BandConfig & {
  // Initial margin may use at most this fraction of equity (0.95).
  marginCap: number;
  // IOC limit = mark ± this many bps.
  slippageBps: number;
};

export type PlannedOrder = {
  asset: string;
  assetId: number;
  isBuy: boolean;
  // Formatted for HL (tick and lot rules).
  price: string;
  size: string;
  reduceOnly: boolean;
  // Signed USD notional of the order at mark.
  notionalUsd: number;
  targetUsd: number;
  currentUsd: number;
};

export type SkippedLeg = {
  asset: string;
  // IN_FLIGHT: an earlier order action for this perp may still land (runner.ts, reconcile.ts).
  // CLOSE_PENDING: target 0, but not for CLOSE_CONFIRM_RUNS runs yet (shared/copy.ts pendingCloses).
  reason: LegSkip | "UNKNOWN_MARKET" | "SIZE_ROUNDS_TO_ZERO" | "NOT_TRADABLE" | "LEVERAGE_FAILED" | "IN_FLIGHT";
  targetUsd: number;
  currentUsd: number;
};

export type Plan = {
  orders: PlannedOrder[];
  skipped: SkippedLeg[];
  // Pro-rata factor applied to all targets by the margin rule (1 = none).
  marginScale: number;
  initialMarginUsd: number;
};

// §4.8: if Σ |N_c| / maxLev_c would exceed marginCap × equity, scale all targets down pro-rata.
// `reservedUsd`: margin of positions kept as they are (pending closes), which isn't scaled.
export const marginScale = (
  targets: Map<string, number>,
  markets: Map<string, Market>,
  equityUsd: number,
  marginCap: number,
  reservedUsd = 0,
): { scale: number; initialMarginUsd: number } => {
  let margin = 0;
  for (const [asset, usd] of targets) {
    const m = markets.get(asset);
    if (m) margin += Math.abs(usd) / m.maxLeverage;
  }
  const limit = Math.max(marginCap * Math.max(equityUsd, 0) - reservedUsd, 0);
  if (margin <= limit) return { scale: 1, initialMarginUsd: margin + reservedUsd };
  const scale = margin > 0 ? limit / margin : 0;
  return { scale, initialMarginUsd: margin * scale + reservedUsd };
};

export const planOrders = (
  targetsUsd: Map<string, number>,
  account: LiveAccount,
  markets: Map<string, Market>,
  cfg: PlanConfig,
  // Perps at 0 whose close isn't confirmed yet (the backend's pendingCloses): kept as they are.
  pendingCloses: ReadonlySet<string> = new Set(),
): Plan => {
  const orders: PlannedOrder[] = [];
  const skipped: SkippedLeg[] = [];

  // Markets failing our own eligibility check: follow reductions only, never open, add
  // to or flip. Capped before the margin rule so they don't use up margin they won't get.
  const targets = new Map<string, number>();
  for (const [asset, targetUsd] of targetsUsd) {
    const market = markets.get(asset);
    if (!market || market.tradable) {
      targets.set(asset, targetUsd);
      continue;
    }
    const currentUsd = (account.positions.get(asset)?.szi ?? 0) * market.markPx;
    const capped = Math.sign(targetUsd) === Math.sign(currentUsd) ? Math.sign(targetUsd) * Math.min(Math.abs(targetUsd), Math.abs(currentUsd)) : 0;
    if (capped !== targetUsd && targetUsd !== 0) skipped.push({ asset, reason: "NOT_TRADABLE", targetUsd, currentUsd });
    targets.set(asset, capped);
  }
  // A pending close keeps its position only while its market is tradable; otherwise it closes now.
  const keeps = (asset: string) => pendingCloses.has(asset) && markets.get(asset)?.tradable === true && !targets.get(asset);
  let reservedUsd = 0;
  for (const [asset, p] of account.positions) {
    const m = markets.get(asset);
    if (m && keeps(asset)) reservedUsd += Math.abs(p.szi * m.markPx) / m.maxLeverage;
  }
  const { scale, initialMarginUsd } = marginScale(targets, markets, account.equityUsd, cfg.marginCap, reservedUsd);

  // Every asset we target or hold; held assets missing from the targets go to 0.
  const assets = [...new Set([...targets.keys(), ...account.positions.keys()])].sort();
  for (const asset of assets) {
    const market = markets.get(asset);
    const szi = account.positions.get(asset)?.szi ?? 0;
    const targetUsd = (targets.get(asset) ?? 0) * scale;
    if (!market) {
      skipped.push({ asset, reason: "UNKNOWN_MARKET", targetUsd, currentUsd: 0 });
      continue;
    }
    const currentUsd = szi * market.markPx;
    const gapUsd = targetUsd - currentUsd;
    const leg = { asset, targetUsd, currentUsd };
    if (gapUsd === 0) continue;

    // A confirmed close is any size (reduce-only); other legs must clear the bands.
    const fullClose = targetUsd === 0 && szi !== 0;
    const skip = legSkip({ targetUsd, currentUsd, equityUsd: account.equityUsd, closePending: keeps(asset) }, cfg);
    if (skip) {
      skipped.push({ ...leg, reason: skip });
      continue;
    }

    const isBuy = gapUsd > 0;
    let size: string;
    try {
      size = fullClose ? formatSize(Math.abs(szi), market.szDecimals) : formatSize(Math.abs(gapUsd) / market.markPx, market.szDecimals);
    } catch {
      skipped.push({ ...leg, reason: "SIZE_ROUNDS_TO_ZERO" });
      continue;
    }
    // formatPrice truncates, so strip float noise first (100000 × 1.005 = 100499.99…).
    const slip = cfg.slippageBps / 10_000;
    const price = formatPrice(Number((market.markPx * (isBuy ? 1 + slip : 1 - slip)).toPrecision(12)), market.szDecimals);
    const notionalUsd = (isBuy ? 1 : -1) * Number(size) * market.markPx;
    // HL's $10 minimum applies to the order itself, so check it at the limit price
    // (a sell at mark − 50 bps is worth less than at mark).
    if (!fullClose && Number(size) * Number(price) < cfg.minOrderUsd) {
      skipped.push({ ...leg, reason: "BELOW_MIN_ORDER" });
      continue;
    }

    // Reduce-only when the order only shrinks the current position (never flips it).
    const reduceOnly = fullClose || (szi !== 0 && Math.sign(gapUsd) === -Math.sign(szi) && Math.abs(gapUsd) <= Math.abs(currentUsd));
    orders.push({ asset, assetId: market.assetId, isBuy, price, size, reduceOnly, notionalUsd, targetUsd, currentUsd });
  }

  // Reductions first, so margin is freed before new risk is added.
  orders.sort((a, b) => Number(b.reduceOnly) - Number(a.reduceOnly));
  return { orders, skipped, marginScale: scale, initialMarginUsd };
};

// Flatten (README §4.8 kill switch): close every position, reduce-only.
export const planFlatten = (account: LiveAccount, markets: Map<string, Market>, slippageBps: number): Plan =>
  planOrders(new Map(), account, markets, { minOrderUsd: 0, driftFraction: 0, equityBandFraction: 0, marginCap: Number.POSITIVE_INFINITY, slippageBps });

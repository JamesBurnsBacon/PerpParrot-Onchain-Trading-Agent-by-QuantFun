// Targets + live account → orders (README §4.4 drift rule, §4.8 margin rule).
// Pure: no I/O, so every rule here is unit-tested.
import { formatPrice, formatSize } from "@nktkas/hyperliquid/utils";

export type Market = {
  name: string;
  assetId: number;
  szDecimals: number;
  maxLeverage: number;
  markPx: number;
};

export type LivePosition = {
  // Signed size in coins (negative = short).
  szi: number;
};

export type LiveAccount = {
  equityUsd: number;
  positions: Map<string, LivePosition>;
};

export type PlanConfig = {
  minOrderUsd: number;
  // Trade a leg only if |gap| ≥ this fraction of |target| (0.1 = 10%).
  driftFraction: number;
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
  reason: "BELOW_DRIFT" | "BELOW_MIN_ORDER" | "UNKNOWN_MARKET" | "SIZE_ROUNDS_TO_ZERO";
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
export const marginScale = (
  targets: Map<string, number>,
  markets: Map<string, Market>,
  equityUsd: number,
  marginCap: number,
): { scale: number; initialMarginUsd: number } => {
  let margin = 0;
  for (const [asset, usd] of targets) {
    const m = markets.get(asset);
    if (m) margin += Math.abs(usd) / m.maxLeverage;
  }
  const limit = marginCap * Math.max(equityUsd, 0);
  if (margin <= limit) return { scale: 1, initialMarginUsd: margin };
  const scale = margin > 0 ? limit / margin : 0;
  return { scale, initialMarginUsd: margin * scale };
};

export const planOrders = (
  targetsUsd: Map<string, number>,
  account: LiveAccount,
  markets: Map<string, Market>,
  cfg: PlanConfig,
): Plan => {
  const { scale, initialMarginUsd } = marginScale(targetsUsd, markets, account.equityUsd, cfg.marginCap);
  const orders: PlannedOrder[] = [];
  const skipped: SkippedLeg[] = [];

  // Every asset we target or hold; held assets missing from the targets go to 0.
  const assets = [...new Set([...targetsUsd.keys(), ...account.positions.keys()])].sort();
  for (const asset of assets) {
    const market = markets.get(asset);
    const szi = account.positions.get(asset)?.szi ?? 0;
    const targetUsd = (targetsUsd.get(asset) ?? 0) * scale;
    if (!market) {
      skipped.push({ asset, reason: "UNKNOWN_MARKET", targetUsd, currentUsd: 0 });
      continue;
    }
    const currentUsd = szi * market.markPx;
    const gapUsd = targetUsd - currentUsd;
    const leg = { asset, targetUsd, currentUsd };
    if (gapUsd === 0) continue;

    // Closing out completely is always allowed (reduce-only, any size).
    const fullClose = targetUsd === 0 && szi !== 0;
    if (!fullClose) {
      if (Math.abs(gapUsd) < cfg.driftFraction * Math.abs(targetUsd)) {
        skipped.push({ ...leg, reason: "BELOW_DRIFT" });
        continue;
      }
      if (Math.abs(gapUsd) < cfg.minOrderUsd) {
        skipped.push({ ...leg, reason: "BELOW_MIN_ORDER" });
        continue;
      }
    }

    const isBuy = gapUsd > 0;
    let size: string;
    try {
      size = fullClose ? formatSize(Math.abs(szi), market.szDecimals) : formatSize(Math.abs(gapUsd) / market.markPx, market.szDecimals);
    } catch {
      skipped.push({ ...leg, reason: "SIZE_ROUNDS_TO_ZERO" });
      continue;
    }
    const notionalUsd = (isBuy ? 1 : -1) * Number(size) * market.markPx;
    if (!fullClose && Math.abs(notionalUsd) < cfg.minOrderUsd) {
      skipped.push({ ...leg, reason: "BELOW_MIN_ORDER" });
      continue;
    }

    // Reduce-only when the order only shrinks the current position (never flips it).
    const reduceOnly = fullClose || (szi !== 0 && Math.sign(gapUsd) === -Math.sign(szi) && Math.abs(gapUsd) <= Math.abs(currentUsd));
    // formatPrice truncates, so strip float noise first (100000 × 1.005 = 100499.99…).
    const slip = cfg.slippageBps / 10_000;
    const price = formatPrice(Number((market.markPx * (isBuy ? 1 + slip : 1 - slip)).toPrecision(12)), market.szDecimals);
    orders.push({ asset, assetId: market.assetId, isBuy, price, size, reduceOnly, notionalUsd, targetUsd, currentUsd });
  }

  // Reductions first, so margin is freed before new risk is added.
  orders.sort((a, b) => Number(b.reduceOnly) - Number(a.reduceOnly));
  return { orders, skipped, marginScale: scale, initialMarginUsd };
};

// Flatten (README §4.8 kill switch): close every position, reduce-only.
export const planFlatten = (account: LiveAccount, markets: Map<string, Market>, slippageBps: number): Plan =>
  planOrders(new Map(), account, markets, { minOrderUsd: 0, driftFraction: 0, marginCap: Number.POSITIVE_INFINITY, slippageBps });

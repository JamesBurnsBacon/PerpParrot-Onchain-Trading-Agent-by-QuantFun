import { ELIGIBLE_DEXES } from "../../shared/snapshot";
import { metaAndAssetCtxs, type AssetCtx, type PerpMeta } from "./hyperliquid";

export const MIN_OI_USD = 20_000_000;

// Eligible: listed, cross-margin allowed, USDC collateral, OI ≥ $20M (README §4.4).
// TODO: hysteresis (stay eligible until < $15M) needs the previous day's list.
export const eligibleFromMeta = ([meta, ctxs]: [PerpMeta, AssetCtx[]]): string[] => {
  if (meta.collateralToken !== 0) return [];
  return meta.universe
    .filter((u, i) => {
      if (u.isDelisted || u.onlyIsolated || u.marginMode === "noCross" || u.marginMode === "strictIsolated") return false;
      const ctx = ctxs[i];
      return Number(ctx.openInterest) * Number(ctx.markPx) >= MIN_OI_USD;
    })
    .map((u) => u.name);
};

export const fetchEligibleAssets = async (): Promise<string[]> => {
  const metas = await Promise.all(ELIGIBLE_DEXES.map(metaAndAssetCtxs));
  return metas.flatMap(eligibleFromMeta).sort();
};

import { ELIGIBLE_DEXES } from "../../shared/snapshot";
import { metaAndAssetCtxs, type AssetCtx, type PerpMeta } from "./hyperliquid";

// README §4.4: enter at ≥ $20M OI, stay eligible until OI falls below $15M.
export const ENTER_OI_USD = 20_000_000;
export const EXIT_OI_USD = 15_000_000;

// Open interest in USD for every listed, cross-margin, USDC-collateral market.
export const openInterestFromMeta = ([meta, ctxs]: [PerpMeta, AssetCtx[]]): Map<string, number> => {
  const oi = new Map<string, number>();
  if (meta.collateralToken !== 0) return oi;
  meta.universe.forEach((u, i) => {
    if (u.isDelisted || u.onlyIsolated || u.marginMode === "noCross" || u.marginMode === "strictIsolated") return;
    oi.set(u.name, Number(ctxs[i].openInterest) * Number(ctxs[i].markPx));
  });
  return oi;
};

// Hysteresis: new assets need ENTER_OI_USD; assets already eligible keep it down to EXIT_OI_USD.
export const applyHysteresis = (oi: Map<string, number>, previous: ReadonlySet<string>): string[] =>
  [...oi]
    .filter(([asset, usd]) => usd >= (previous.has(asset) ? EXIT_OI_USD : ENTER_OI_USD))
    .map(([asset]) => asset)
    .sort();

export const fetchOpenInterest = async (): Promise<Map<string, number>> => {
  const metas = await Promise.all(ELIGIBLE_DEXES.map(metaAndAssetCtxs));
  return new Map(metas.flatMap((m) => [...openInterestFromMeta(m)]));
};

// Re-checked daily (README §4.4); the list is held between checks so snapshots
// within a day agree on eligibility.
export class EligibilityTracker {
  private assets: string[] = [];
  private checkedAt = 0;

  constructor(
    private readonly fetchOi: () => Promise<Map<string, number>> = fetchOpenInterest,
    private readonly refreshMs = 24 * 60 * 60 * 1000,
  ) {}

  async current(nowMs: number): Promise<string[]> {
    if (this.assets.length === 0 || nowMs - this.checkedAt >= this.refreshMs) {
      this.assets = applyHysteresis(await this.fetchOi(), new Set(this.assets));
      this.checkedAt = nowMs;
    }
    return this.assets;
  }
}

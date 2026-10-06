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

export type EligibilityState = { assets: string[]; checkedAt: number };

// Persisted so hysteresis survives restarts and every instance agrees on the list.
export interface EligibilityStore {
  load(): Promise<EligibilityState | undefined>;
  save(state: EligibilityState): Promise<void>;
}

export class MemoryEligibilityStore implements EligibilityStore {
  private state?: EligibilityState;
  async load() {
    return this.state;
  }
  async save(state: EligibilityState) {
    this.state = state;
  }
}

const DAY_MS = 24 * 60 * 60 * 1000;

// Re-checked once per UTC day (README §4.4), on the first snapshot after midnight, so
// every snapshot within a day agrees on eligibility. A check that would drop more than
// max(3, 20%) of the list at once is refused (kept: yesterday's list) as a likely data
// error, since every dropped asset we hold gets closed.
export class EligibilityTracker {
  constructor(
    private readonly store: EligibilityStore = new MemoryEligibilityStore(),
    private readonly fetchOi: () => Promise<Map<string, number>> = fetchOpenInterest,
    private readonly onRefused: (message: string) => void = () => {},
  ) {}

  async current(nowMs: number): Promise<string[]> {
    const previous = await this.store.load();
    const dayStart = Math.floor(nowMs / DAY_MS) * DAY_MS;
    if (previous && previous.checkedAt >= dayStart) return previous.assets;

    const next = applyHysteresis(await this.fetchOi(), new Set(previous?.assets ?? []));
    if (previous) {
      const kept = new Set(next);
      const dropped = previous.assets.filter((a) => !kept.has(a));
      if (dropped.length > Math.max(3, Math.floor(previous.assets.length * 0.2))) {
        this.onRefused(`eligibility check would drop ${dropped.length} of ${previous.assets.length} assets; keeping the previous list`);
        await this.store.save({ assets: previous.assets, checkedAt: nowMs });
        return previous.assets;
      }
    }
    await this.store.save({ assets: next, checkedAt: nowMs });
    return next;
  }
}

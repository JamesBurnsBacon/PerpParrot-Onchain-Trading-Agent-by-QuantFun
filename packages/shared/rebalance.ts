// The per-perp trading rule shared by the live executor (executor/src/planner.ts) and the paper
// books (backend/src/paper/book.ts), so paper trades exactly like live (README §4.4).
// Pure, no I/O.

export type BandConfig = {
  minOrderUsd: number;
  // Trade a leg only if |gap| ≥ this fraction of |target| (0.1 = 10%)...
  driftFraction: number;
  // ...and ≥ this fraction of equity (0.005 = 0.5%), so small targets don't trade on noise.
  equityBandFraction: number;
};

export type LegSkip = "BELOW_DRIFT" | "BELOW_MIN_ORDER" | "BELOW_EQUITY_BAND" | "CLOSE_PENDING";

// Why a perp with a nonzero gap is not traded this run, or null to trade it. A full close (target 0)
// is any size and skips the bands, but waits while its close is pending (shared/copy.ts pendingCloses).
export const legSkip = (
  leg: { targetUsd: number; currentUsd: number; equityUsd: number; closePending: boolean },
  cfg: BandConfig,
): LegSkip | null => {
  if (leg.targetUsd === 0 && leg.currentUsd !== 0) return leg.closePending ? "CLOSE_PENDING" : null;
  const gap = Math.abs(leg.targetUsd - leg.currentUsd);
  if (gap < cfg.driftFraction * Math.abs(leg.targetUsd)) return "BELOW_DRIFT";
  if (gap < cfg.minOrderUsd) return "BELOW_MIN_ORDER";
  if (gap < cfg.equityBandFraction * Math.max(leg.equityUsd, 0)) return "BELOW_EQUITY_BAND";
  return null;
};

// Positions snapshot the backend reads for each run (README §4.7): the frozen sources' positions
// and equity. GET {backendUrl}/snapshots/{runAt}; immutable once built, so the run's targets,
// the paper books and the recorded snapshot hash all come from the same bytes. Amounts are
// decimal strings scaled by 1e6.
import type { FrozenConfiguration } from "./frozen";

export type SnapshotPosition = {
  asset: string;
  // Signed USD notional × 1e6 (negative = short).
  notionalE6: string;
};

export type SnapshotSource = {
  address: string;
  // HL's live account value × 1e6 (shared/account.ts: portfolio request).
  equityE6: string;
  // Eligible assets only.
  positions: SnapshotPosition[];
};

export type PositionsSnapshot = {
  snapshotId: string;
  // Unix seconds of the mirror run this snapshot is for.
  runAt: number;
  // Unix seconds the positions were read.
  // Start of the read window; freshness is measured from this conservative bound.
  startedAt?: number;
  // Completion time of all source reads.
  takenAt: number;
  // The frozen configuration: source set, weights, policy and our account (shared/frozen.ts).
  configuration: FrozenConfiguration;
  eligibleAssets: string[];
  // One entry per frozen source, sorted by address.
  sources: SnapshotSource[];
};

// Perp dexes with eligible markets: core ("") and the xyz HIP-3 dex.
export const ELIGIBLE_DEXES = ["", "xyz"] as const;

// Positions snapshot served by the backend to the mirror workflow (README §4.7).
// GET {backendUrl}/snapshots/{runAt}: immutable once built, so every DON node
// gets byte-identical JSON. Amounts are decimal strings scaled by 1e6.
import type { Manifest } from "./manifest";

export type SnapshotPosition = {
  asset: string;
  // Signed USD notional × 1e6 (negative = short).
  notionalE6: string;
};

export type SnapshotSource = {
  address: string;
  // Account value across the eligible dexes (core + xyz) × 1e6.
  equityE6: string;
  // Eligible assets only.
  positions: SnapshotPosition[];
};

export type PositionsSnapshot = {
  snapshotId: string;
  // Unix seconds of the mirror run this snapshot is for.
  runAt: number;
  // Unix seconds the positions were read.
  takenAt: number;
  // The frozen live manifest: the source set, weights and policy (shared/manifest.ts).
  manifest: Manifest;
  eligibleAssets: string[];
  // One entry per manifest source, sorted by address.
  sources: SnapshotSource[];
};

// Perp dexes with eligible markets: core ("") and the xyz HIP-3 dex.
export const ELIGIBLE_DEXES = ["", "xyz"] as const;

import { keccak256, stringToBytes, toHex } from "viem";
import { z } from "zod";
import type { WeightedSource } from "../../shared/copy";
import { checkFrozenManifest, manifestWeightsE6, type KeccakUtf8, type Manifest } from "../../shared/manifest";
import type { PositionsSnapshot } from "../../shared/snapshot";

export const keccakUtf8: KeccakUtf8 = (text) => keccak256(stringToBytes(text));

const decimal = z.string().regex(/^-?\d+$/);

// Structure only. The manifest is left untouched (zod would strip nested keys and
// break its commitment); checkFrozenManifest verifies it against the pinned hash.
export const snapshotSchema = z.object({
  snapshotId: z.string(),
  runAt: z.number().int(),
  takenAt: z.number().int(),
  manifest: z.record(z.unknown()),
  eligibleAssets: z.array(z.string()),
  sources: z
    .array(
      z.object({
        address: z.string().regex(/^0x[0-9a-f]{40}$/),
        equityE6: decimal,
        positions: z.array(z.object({ asset: z.string(), notionalE6: decimal })),
      }),
    )
    .min(1),
}) as unknown as z.ZodType<PositionsSnapshot>;

export type SnapshotLimits = { frozenManifestHash: string; runAt: number; maxSnapshotAgeSeconds: number };

// Rejects a snapshot that isn't for this run, is stale, isn't backed by the frozen
// live manifest, or doesn't cover exactly the manifest's sources.
// Returns the sources with their manifest weights.
export const checkSnapshot = (s: PositionsSnapshot, limits: SnapshotLimits): WeightedSource[] => {
  if (s.runAt !== limits.runAt) throw new Error(`snapshot is for run ${s.runAt}, expected ${limits.runAt}`);
  if (Math.abs(limits.runAt - s.takenAt) > limits.maxSnapshotAgeSeconds) {
    throw new Error(`snapshot taken ${limits.runAt - s.takenAt}s before the run`);
  }
  // The run time, not the node clock, so every node reaches the same verdict.
  checkFrozenManifest(keccakUtf8, s.manifest as Manifest, limits.runAt * 1000, limits.frozenManifestHash);

  const weights = manifestWeightsE6(s.manifest);
  const addresses = s.sources.map((src) => src.address);
  if (new Set(addresses).size !== addresses.length || addresses.length !== weights.size || !addresses.every((a) => weights.has(a))) {
    throw new Error("snapshot sources don't match the manifest");
  }
  const eligible = new Set(s.eligibleAssets);
  for (const src of s.sources) {
    for (const p of src.positions) {
      if (!eligible.has(p.asset)) throw new Error(`ineligible asset in snapshot: ${p.asset}`);
    }
  }
  return s.sources.map((src) => ({ ...src, weightE6: weights.get(src.address)! }));
};

// Deterministic per snapshot, so every node spot-checks the same sources.
export const pickSample = <T>(items: T[], seed: string, count: number): T[] => {
  const picked = new Set<number>();
  for (let i = 0; picked.size < Math.min(count, items.length); i++) {
    picked.add(Number(BigInt(keccak256(toHex(`${seed}:${i}`))) % BigInt(items.length)));
  }
  return [...picked].sort((a, b) => a - b).map((i) => items[i]);
};

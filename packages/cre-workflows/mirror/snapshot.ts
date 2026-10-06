import { keccak256, stringToBytes, toHex } from "viem";
import { z } from "zod";
import { checkActiveCeilings, type WeightedSource } from "../../shared/copy";
import type { KeccakUtf8 } from "../../shared/commitments";
import { checkFrozenConfiguration, type FrozenConfiguration } from "../../shared/frozen";
import type { PositionsSnapshot } from "../../shared/snapshot";

export const keccakUtf8: KeccakUtf8 = (text) => keccak256(stringToBytes(text));

const decimal = z.string().regex(/^-?\d+$/);

// Structure only. The configuration is left untouched (zod would strip nested keys
// and break its commitment); checkFrozenConfiguration verifies it against the pinned hash.
export const snapshotSchema = z.object({
  snapshotId: z.string(),
  runAt: z.number().int(),
  takenAt: z.number().int(),
  configuration: z.record(z.unknown()),
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

export type SnapshotLimits = { frozenConfigurationHash: string; runAt: number; maxSnapshotAgeSeconds: number };

// Rejects a snapshot that isn't for this run, is stale, isn't backed by the pinned
// frozen configuration, or doesn't cover exactly its sources.
// Returns the sources with their frozen weights and ceilings.
export const checkSnapshot = (s: PositionsSnapshot, limits: SnapshotLimits): WeightedSource[] => {
  if (s.runAt !== limits.runAt) throw new Error(`snapshot is for run ${s.runAt}, expected ${limits.runAt}`);
  if (Math.abs(limits.runAt - s.takenAt) > limits.maxSnapshotAgeSeconds) {
    throw new Error(`snapshot taken ${limits.runAt - s.takenAt}s before the run`);
  }
  // The run time, not the node clock, so every node reaches the same verdict.
  const configuration = s.configuration as FrozenConfiguration;
  checkFrozenConfiguration(keccakUtf8, configuration, limits.frozenConfigurationHash, limits.runAt * 1000);

  const frozen = new Map(configuration.sources.map((f) => [f.sourceAddress, f]));
  const addresses = s.sources.map((src) => src.address);
  if (new Set(addresses).size !== addresses.length || addresses.length !== frozen.size || !addresses.every((a) => frozen.has(a))) {
    throw new Error("snapshot sources don't match the frozen configuration");
  }
  const eligible = new Set(s.eligibleAssets);
  for (const src of s.sources) {
    for (const p of src.positions) {
      if (!eligible.has(p.asset)) throw new Error(`ineligible asset in snapshot: ${p.asset}`);
    }
  }
  const weighted = s.sources.map((src) => ({
    ...src,
    weightE6: frozen.get(src.address)!.weightUnits,
    ceilingE6: frozen.get(src.address)!.ceilingUnits,
  }));
  checkActiveCeilings(weighted);
  return weighted;
};

// Deterministic per snapshot, so every node spot-checks the same sources.
export const pickSample = <T>(items: T[], seed: string, count: number): T[] => {
  const picked = new Set<number>();
  for (let i = 0; picked.size < Math.min(count, items.length); i++) {
    picked.add(Number(BigInt(keccak256(toHex(`${seed}:${i}`))) % BigInt(items.length)));
  }
  return [...picked].sort((a, b) => a - b).map((i) => items[i]);
};

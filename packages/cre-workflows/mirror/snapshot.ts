import { encodeAbiParameters, getAddress, keccak256, parseAbiParameters, toHex, type Hex } from "viem";
import { z } from "zod";
import { FROZEN_SET_ABI, type PositionsSnapshot, type SnapshotSource } from "../../shared/snapshot";

const decimal = z.string().regex(/^-?\d+$/);

export const snapshotSchema = z.object({
  snapshotId: z.string(),
  runAt: z.number().int(),
  takenAt: z.number().int(),
  frozenSetHash: z.string().regex(/^0x[0-9a-f]{64}$/),
  eligibleAssets: z.array(z.string()),
  sources: z
    .array(
      z.object({
        address: z.string().regex(/^0x[0-9a-f]{40}$/),
        weightE6: z.number().int().nonnegative(),
        equityE6: decimal,
        positions: z.array(z.object({ asset: z.string(), notionalE6: decimal })),
      }),
    )
    .min(1),
}) as z.ZodType<PositionsSnapshot>;

// Same encoding as packages/backend/src/snapshot.ts frozenSetHash().
export const frozenSetHash = (sources: Pick<SnapshotSource, "address" | "weightE6">[]): Hex =>
  keccak256(
    encodeAbiParameters(parseAbiParameters(FROZEN_SET_ABI), [
      [...sources]
        .sort((a, b) => (a.address < b.address ? -1 : 1))
        .map((s) => ({ source: getAddress(s.address), weightE6: s.weightE6 })),
    ]),
  );

export type SnapshotLimits = { frozenSetHash: string; runAt: number; maxSnapshotAgeSeconds: number };

// Rejects a snapshot that isn't for this run, is stale, or carries a different source set.
export const checkSnapshot = (s: PositionsSnapshot, limits: SnapshotLimits): void => {
  if (s.runAt !== limits.runAt) throw new Error(`snapshot is for run ${s.runAt}, expected ${limits.runAt}`);
  if (Math.abs(limits.runAt - s.takenAt) > limits.maxSnapshotAgeSeconds) {
    throw new Error(`snapshot taken ${limits.runAt - s.takenAt}s before the run`);
  }
  if (s.frozenSetHash !== limits.frozenSetHash) throw new Error("snapshot frozen set differs from config");
  if (frozenSetHash(s.sources) !== limits.frozenSetHash) throw new Error("snapshot sources don't match the frozen set");
  const eligible = new Set(s.eligibleAssets);
  for (const src of s.sources) {
    for (const p of src.positions) {
      if (!eligible.has(p.asset)) throw new Error(`ineligible asset in snapshot: ${p.asset}`);
    }
  }
};

// Deterministic per snapshot, so every node spot-checks the same sources.
export const pickSample = <T>(items: T[], seed: string, count: number): T[] => {
  const picked = new Set<number>();
  for (let i = 0; picked.size < Math.min(count, items.length); i++) {
    picked.add(Number(BigInt(keccak256(toHex(`${seed}:${i}`))) % BigInt(items.length)));
  }
  return [...picked].sort((a, b) => a - b).map((i) => items[i]);
};

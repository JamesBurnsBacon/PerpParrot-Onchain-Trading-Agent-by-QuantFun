import { keccak256, stringToBytes } from "viem";
import { parseAccount } from "../../shared/copy";
import type { KeccakUtf8, Manifest } from "../../shared/manifest";
import { ELIGIBLE_DEXES, type PositionsSnapshot } from "../../shared/snapshot";
import { clearinghouseState } from "./hyperliquid";

export const keccakUtf8: KeccakUtf8 = (text) => keccak256(stringToBytes(text));

export type ReadAccount = typeof clearinghouseState;

// Reads every manifest source on each eligible dex. Sources are sorted by address
// so the JSON is canonical for a given set of readings.
export const buildSnapshot = async (
  manifest: Manifest,
  eligibleAssets: string[],
  runAt: number,
  takenAt: number,
  readAccount: ReadAccount = clearinghouseState,
): Promise<PositionsSnapshot> => {
  const eligible = new Set(eligibleAssets);
  const addresses = manifest.sources.map((s) => s.sourceAddress.toLowerCase()).sort();
  const sources = await Promise.all(
    addresses.map(async (address) => {
      const states = await Promise.all(ELIGIBLE_DEXES.map((dex) => readAccount(address, dex)));
      const account = parseAccount(states, eligible);
      return {
        address,
        equityE6: account.equityE6.toString(),
        positions: [...account.positions]
          .sort(([a], [b]) => (a < b ? -1 : 1))
          .map(([asset, n]) => ({ asset, notionalE6: n.toString() })),
      };
    }),
  );
  return { snapshotId: `snap-${runAt}`, runAt, takenAt, manifest, eligibleAssets, sources };
};

// Snapshots are written once per runAt and never changed, so every DON node
// fetching the same run gets identical bytes. In memory for now; Supabase once
// the project is connected.
export interface SnapshotStore {
  get(runAt: number): Promise<string | undefined>;
  // Returns the stored JSON: the existing one if another writer got there first.
  putIfAbsent(runAt: number, json: string): Promise<string>;
}

export class MemorySnapshotStore implements SnapshotStore {
  private readonly snapshots = new Map<number, string>();

  constructor(private readonly keep = 500) {}

  async get(runAt: number) {
    return this.snapshots.get(runAt);
  }

  async putIfAbsent(runAt: number, json: string) {
    const existing = this.snapshots.get(runAt);
    if (existing) return existing;
    this.snapshots.set(runAt, json);
    for (const key of this.snapshots.keys()) {
      if (this.snapshots.size <= this.keep) break;
      this.snapshots.delete(key);
    }
    return json;
  }
}

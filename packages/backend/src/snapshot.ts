import { keccak256, stringToBytes } from "viem";
import { readAccountState } from "../../shared/account";
import type { KeccakUtf8 } from "../../shared/commitments";
import type { FrozenConfiguration } from "../../shared/frozen";
import { ELIGIBLE_DEXES, type PositionsSnapshot } from "../../shared/snapshot";
import { hlReader, type HlReader } from "./hyperliquid";

export const keccakUtf8: KeccakUtf8 = (text) => keccak256(stringToBytes(text));

// Reads every frozen source: positions on each eligible dex and HL's live account
// value. Sources are sorted by address so the JSON is canonical for a given set of readings.
export const buildSnapshot = async (
  configuration: FrozenConfiguration,
  eligibleAssets: string[],
  runAt: number,
  nowMs: () => number,
  hl: HlReader = hlReader,
): Promise<PositionsSnapshot> => {
  const startedAt = Math.floor(nowMs() / 1000);
  const eligible = new Set(eligibleAssets);
  const addresses = configuration.sources.map((s) => s.sourceAddress.toLowerCase()).sort();
  const sources = await Promise.all(
    addresses.map(async (address) => {
      const [perpStates, portfolio] = await Promise.all([
        Promise.all(ELIGIBLE_DEXES.map((dex) => hl.perp(address, dex))),
        hl.portfolio(address),
      ]);
      const account = readAccountState(perpStates, portfolio, eligible);
      return {
        address,
        equityE6: account.equityE6.toString(),
        positions: [...account.positions]
          .sort(([a], [b]) => (a < b ? -1 : 1))
          .map(([asset, n]) => ({ asset, notionalE6: n.toString() })),
      };
    }),
  );
  const takenAt = Math.floor(nowMs() / 1000);
  return { snapshotId: `snap-${runAt}`, runAt, startedAt, takenAt, configuration, eligibleAssets, sources };
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

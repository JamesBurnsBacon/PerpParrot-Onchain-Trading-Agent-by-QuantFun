import { encodeAbiParameters, getAddress, keccak256, parseAbiParameters, type Hex } from "viem";
import { parseAccount } from "../../shared/copy";
import { ELIGIBLE_DEXES, FROZEN_SET_ABI, type PositionsSnapshot } from "../../shared/snapshot";
import { clearinghouseState } from "./hyperliquid";

export type FrozenSource = { address: Hex; weightE6: number };

const sortByAddress = (set: FrozenSource[]) =>
  [...set].sort((a, b) => (a.address.toLowerCase() < b.address.toLowerCase() ? -1 : 1));

export const frozenSetHash = (set: FrozenSource[]): Hex =>
  keccak256(
    encodeAbiParameters(parseAbiParameters(FROZEN_SET_ABI), [
      sortByAddress(set).map((s) => ({ source: getAddress(s.address), weightE6: s.weightE6 })),
    ]),
  );

export const buildSnapshot = async (
  set: FrozenSource[],
  eligibleAssets: string[],
  runAt: number,
  now: () => number = () => Math.floor(Date.now() / 1000),
): Promise<PositionsSnapshot> => {
  const eligible = new Set(eligibleAssets);
  const sources = await Promise.all(
    sortByAddress(set).map(async (s) => {
      const states = await Promise.all(ELIGIBLE_DEXES.map((dex) => clearinghouseState(s.address, dex)));
      const account = parseAccount(states, eligible);
      return {
        address: s.address.toLowerCase() as Hex,
        weightE6: s.weightE6,
        equityE6: account.equityE6.toString(),
        positions: [...account.positions]
          .sort(([a], [b]) => (a < b ? -1 : 1))
          .map(([asset, n]) => ({ asset, notionalE6: n.toString() })),
      };
    }),
  );
  return {
    snapshotId: `snap-${runAt}`,
    runAt,
    takenAt: now(),
    frozenSetHash: frozenSetHash(set),
    eligibleAssets,
    sources,
  };
};

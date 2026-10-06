import { z } from "zod";
import { addressSchema, compareUsd, decimalSchema, MIN_EQUITY_USD, type Candidate } from "./types";

const leaderboardRow = z.object({
  ethAddress: addressSchema,
  accountValue: decimalSchema,
  displayName: z.string().nullable().optional(),
});
const vaultRow = z.object({ summary: z.object({
  vaultAddress: addressSchema,
  tvl: decimalSchema,
  isClosed: z.boolean(),
  name: z.string(),
  leader: addressSchema,
}) });

export function discover(leaderboard: unknown, vaultList: unknown, limit: number) {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) throw new Error("limit must be 1..500");
  const rows = z.object({ leaderboardRows: z.array(leaderboardRow) }).parse(leaderboard).leaderboardRows;
  const vaults = z.array(vaultRow).parse(vaultList).map((v) => v.summary);
  const vaultByAddress = new Map(vaults.map((v) => [v.vaultAddress, v]));
  // Ambiguous source data should fail the run, not silently overwrite an address.
  if (vaultByAddress.size !== vaults.length) throw new Error("Duplicate addresses in vault list");
  const byAddress = new Map<string, Candidate>();
  for (const row of rows) {
    const vault = vaultByAddress.get(row.ethAddress);
    if (vault?.isClosed) continue;
    if (byAddress.has(row.ethAddress)) throw new Error("Duplicate addresses in leaderboard");
    byAddress.set(row.ethAddress, {
      address: row.ethAddress,
      accountValueOrTvlUsd: vault?.tvl ?? row.accountValue,
      valueSource: vault ? "hypercore-vault-tvl" : "leaderboard-account-value",
      sources: vault ? ["leaderboard", "hypercore-vault-list"] : ["leaderboard"],
      name: vault?.name ?? row.displayName ?? null,
      knownHypercoreVault: !!vault,
      leaderAddress: vault?.leader ?? null,
    });
  }
  for (const vault of vaults) {
    if (vault.isClosed || byAddress.has(vault.vaultAddress)) continue;
    byAddress.set(vault.vaultAddress, {
      address: vault.vaultAddress, accountValueOrTvlUsd: vault.tvl,
      valueSource: "hypercore-vault-tvl", sources: ["hypercore-vault-list"],
      name: vault.name, knownHypercoreVault: true, leaderAddress: vault.leader,
    });
  }
  const candidates = [...byAddress.values()]
    .filter((c) => compareUsd(c.accountValueOrTvlUsd, MIN_EQUITY_USD) >= 0)
    .sort((a, b) => compareUsd(b.accountValueOrTvlUsd, a.accountValueOrTvlUsd)
      || a.address.localeCompare(b.address));
  return {
    stats: {
      leaderboardRows: rows.length, vaultRows: vaults.length,
      openVaults: vaults.filter((v) => !v.isClosed).length,
      leaderboardAboveMinimum: rows.filter((r) => compareUsd(r.accountValue, MIN_EQUITY_USD) >= 0).length,
      openVaultsAboveMinimum: vaults.filter((v) => !v.isClosed && compareUsd(v.tvl, MIN_EQUITY_USD) >= 0).length,
      eligibleUniqueAddresses: candidates.length,
      shortlisted: Math.min(limit, candidates.length),
    },
    candidates,
    shortlist: candidates.slice(0, limit),
  };
}

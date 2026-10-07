import { z } from "zod";

export const addressSchema = z.string().regex(/^0x[0-9a-fA-F]{40}$/).transform((s) => s.toLowerCase() as `0x${string}`);
export const decimalSchema = z.string().max(100).regex(/^-?\d+(?:\.\d+)?$/);
export type Address = z.infer<typeof addressSchema>;
export const MIN_EQUITY_USD = "10000";

// Compare the original decimal strings without rounding around the $10k cutoff.
export function compareUsd(a: string, b: string): number {
  decimalSchema.parse(a);
  decimalSchema.parse(b);
  const places = Math.max(a.split(".")[1]?.length ?? 0, b.split(".")[1]?.length ?? 0);
  const scaled = (s: string) => {
    const sign = s.startsWith("-") ? -1n : 1n;
    const [whole, fraction = ""] = s.replace(/^-/, "").split(".");
    return sign * BigInt(whole + fraction.padEnd(places, "0"));
  };
  const x = scaled(a), y = scaled(b);
  return x < y ? -1 : x > y ? 1 : 0;
}

export type Candidate = {
  address: Address;
  accountValueOrTvlUsd: string;
  valueSource: "leaderboard-account-value" | "hypercore-vault-tvl";
  sources: ("leaderboard" | "hypercore-vault-list")[];
  name: string | null;
  knownHypercoreVault: boolean;
  leaderAddress: Address | null;
};

export type KindResult = {
  kind: "trader" | "hypercore-vault" | "erc4626-vault";
  evidence: "vault-list" | "no-hyperevm-code" | "erc4626-probes" | "contract-probes-failed";
  blockNumber?: string;
  asset?: Address;
  totalAssets?: string;
};

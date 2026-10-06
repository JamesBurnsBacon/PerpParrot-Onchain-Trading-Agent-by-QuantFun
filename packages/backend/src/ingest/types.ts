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

const point = z.tuple([z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER), decimalSchema]);
export const portfolioSchema = z.array(z.tuple([z.string(), z.object({
  accountValueHistory: z.array(point),
  pnlHistory: z.array(point),
  vlm: decimalSchema,
})]));

export function summarizePortfolio(raw: unknown) {
  const windows = portfolioSchema.parse(raw);
  if (new Set(windows.map(([w]) => w)).size !== windows.length) throw new Error("Duplicate portfolio windows");
  if (!["month", "allTime"].every((w) => windows.some(([name]) => name === w))) {
    throw new Error("Portfolio missing month or allTime window");
  }
  return Object.fromEntries(windows.map(([name, history]) => {
    for (const series of [history.accountValueHistory, history.pnlHistory]) {
      for (let i = 1; i < series.length; i++) {
        if (series[i][0] <= series[i - 1][0]) throw new Error(`Non-monotonic ${name} history: timestamps must strictly increase`);
      }
    }
    return [name, {
      accountValuePoints: history.accountValueHistory.length,
      pnlPoints: history.pnlHistory.length,
      firstPnlTimeMs: history.pnlHistory[0]?.[0] ?? null,
      lastPnlTimeMs: history.pnlHistory.at(-1)?.[0] ?? null,
      volumeUsd: history.vlm,
    }];
  }));
}

export type CollectionRecord = {
  address: Address;
  classification: KindResult | null;
  classificationError: string | null;
  portfolio: {
    path: string;
    sha256: string;
    fetchedAt: string;
    windows: ReturnType<typeof summarizePortfolio> | null;
  } | null;
  portfolioError: string | null;
};

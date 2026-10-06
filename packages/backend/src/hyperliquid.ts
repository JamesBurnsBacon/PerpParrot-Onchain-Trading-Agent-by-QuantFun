import type { PerpState, PortfolioResponse } from "../../shared/account";

const INFO_URL = "https://api.hyperliquid.xyz/info";

export const info = async <T>(body: Record<string, unknown>): Promise<T> => {
  const res = await fetch(INFO_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`HL info ${body.type} failed: ${res.status}`);
  return (await res.json()) as T;
};

export type PerpMeta = {
  universe: {
    name: string;
    maxLeverage: number;
    isDelisted?: boolean;
    onlyIsolated?: boolean;
    marginMode?: string;
  }[];
  collateralToken: number;
};

export type AssetCtx = { openInterest: string; markPx: string; funding?: string };

export const metaAndAssetCtxs = (dex: string) =>
  info<[PerpMeta, AssetCtx[]]>({ type: "metaAndAssetCtxs", ...(dex ? { dex } : {}) });

// Account reads used to build snapshots; an interface so tests can stub HL.
export type HlReader = {
  perp(user: string, dex: string): Promise<PerpState>;
  portfolio(user: string): Promise<PortfolioResponse>;
};

export const hlReader: HlReader = {
  perp: (user, dex) => info({ type: "clearinghouseState", user, ...(dex ? { dex } : {}) }),
  portfolio: (user) => info({ type: "portfolio", user }),
};

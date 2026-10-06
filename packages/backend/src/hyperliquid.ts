const INFO_URL = "https://api.hyperliquid.xyz/info";

export const info = async <T>(body: Record<string, unknown>): Promise<T> => {
  const res = await fetch(INFO_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
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

export type AssetCtx = { openInterest: string; markPx: string };

export const metaAndAssetCtxs = (dex: string) =>
  info<[PerpMeta, AssetCtx[]]>({ type: "metaAndAssetCtxs", ...(dex ? { dex } : {}) });

export const clearinghouseState = (user: string, dex: string) =>
  info<{
    marginSummary: { accountValue: string };
    assetPositions: { position: { coin: string; szi: string; positionValue: string } }[];
  }>({ type: "clearinghouseState", user, ...(dex ? { dex } : {}) });

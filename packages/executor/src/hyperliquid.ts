// Hyperliquid reads for the executor: market metadata and our live account.
import { ELIGIBLE_DEXES } from "../../shared/snapshot";
import type { LiveAccount, Market } from "./planner";

export type InfoFn = <T>(body: Record<string, unknown>) => Promise<T>;

export const httpInfo =
  (url = "https://api.hyperliquid.xyz/info"): InfoFn =>
  async <T>(body: Record<string, unknown>) => {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(8_000),
    });
    if (!res.ok) throw new Error(`HL info ${body.type} failed: ${res.status}`);
    return (await res.json()) as T;
  };

type Meta = { universe: { name: string; szDecimals: number; maxLeverage: number; isDelisted?: boolean }[] };
type Ctx = { markPx: string | null };

// Asset IDs: core perps use their index; builder (HIP-3) dexes use
// 100000 + dexIndex × 10000 + index (same rule as @nktkas/hyperliquid SymbolConverter).
export const loadMarkets = async (info: InfoFn): Promise<Map<string, Market>> => {
  const dexes = await info<({ name: string } | null)[]>({ type: "perpDexs" });
  const markets = new Map<string, Market>();
  for (const dex of ELIGIBLE_DEXES) {
    const dexIndex = dex ? dexes.findIndex((d) => d?.name === dex) : 0;
    if (dexIndex < 0) throw new Error(`perp dex ${dex} not found`);
    const offset = dex ? 100_000 + dexIndex * 10_000 : 0;
    const [meta, ctxs] = await info<[Meta, Ctx[]]>({ type: "metaAndAssetCtxs", ...(dex ? { dex } : {}) });
    meta.universe.forEach((u, i) => {
      const markPx = Number(ctxs[i]?.markPx);
      if (u.isDelisted || !(markPx > 0)) return;
      markets.set(u.name, { name: u.name, assetId: offset + i, szDecimals: u.szDecimals, maxLeverage: u.maxLeverage, markPx });
    });
  }
  return markets;
};

type ClearinghouseState = {
  marginSummary: { accountValue: string };
  assetPositions: { position: { coin: string; szi: string } }[];
};

// Equity and positions across the eligible dexes (core + xyz).
export const loadAccount = async (info: InfoFn, user: string): Promise<LiveAccount> => {
  const states = await Promise.all(
    ELIGIBLE_DEXES.map((dex) => info<ClearinghouseState>({ type: "clearinghouseState", user, ...(dex ? { dex } : {}) })),
  );
  let equityUsd = 0;
  const positions = new Map<string, { szi: number }>();
  for (const state of states) {
    equityUsd += Number(state.marginSummary.accountValue);
    for (const { position } of state.assetPositions) {
      const szi = Number(position.szi);
      if (szi !== 0) positions.set(position.coin, { szi });
    }
  }
  return { equityUsd, positions };
};

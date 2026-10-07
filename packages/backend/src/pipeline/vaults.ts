// The vault half of the tracked set: hyperliquidvaults.com's "qualified" HyperCore vaults
// (~180, screened by TVL and age, ranked by its hv_score), with Hyperliquid's own vault list as
// the fallback. The site has no public API: its page loads the list from a TanStack server
// function whose ID changes when the site redeploys, so a stale ID is re-found in its bundle.
import { getJson } from "./hl";
import type { Tracked } from "./derive";

const SITE = "https://hyperliquidvaults.com";
// The vault list's server function as of 2026-10-07.
const KNOWN_FUNCTION = "9716c6e39f5df934ddc17b8340aeb983b7d1c3087e9bf8fde8e7c93458aadbfa";

type SiteVault = { vault_address: string; name: string; current_tvl: number; hv_score: number };

// Seroval (the site's wire format) to plain JSON: objects (10/11), arrays (9), numbers and strings
// (0/1/3), constants (2) and back-references (4) are all the list uses.
export const decodeSeroval = (node: unknown, refs = new Map<number, unknown>()): unknown => {
  if (typeof node !== "object" || node === null) return node;
  const n = node as { t: number; i?: number; s?: unknown; a?: unknown[]; p?: { k: string[]; v: unknown[] } };
  switch (n.t) {
    case 0:
    case 1:
      return n.s;
    case 2:
      return n.s === 2 ? true : n.s === 3 ? false : null;
    case 3:
      return Number(n.s);
    case 4:
      return refs.get(n.i!);
    case 9: {
      const array: unknown[] = [];
      refs.set(n.i!, array);
      for (const item of n.a ?? []) array.push(decodeSeroval(item, refs));
      return array;
    }
    case 10:
    case 11: {
      const object: Record<string, unknown> = {};
      refs.set(n.i!, object);
      n.p!.k.forEach((key, index) => (object[key] = decodeSeroval(n.p!.v[index], refs)));
      return object;
    }
    default:
      return undefined;
  }
};

const callFunction = async (id: string): Promise<SiteVault[] | undefined> => {
  const res = await fetch(`${SITE}/_serverFn/${id}`, {
    headers: { "x-tsr-serverFn": "true", Origin: SITE },
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) return undefined;
  const result = (decodeSeroval(await res.json()) as { result?: unknown } | undefined)?.result;
  return Array.isArray(result) && result.length > 0 && typeof (result[0] as SiteVault).vault_address === "string"
    ? (result as SiteVault[])
    : undefined;
};

const siteVaults = async (): Promise<SiteVault[]> => {
  const known = await callFunction(KNOWN_FUNCTION).catch(() => undefined);
  if (known) return known;
  const html = await (await fetch(SITE, { signal: AbortSignal.timeout(20_000) })).text();
  const bundle = /\/assets\/index-[\w-]+\.js/.exec(html)?.[0];
  if (!bundle) throw new Error("hyperliquidvaults.com: no bundle");
  const js = await (await fetch(`${SITE}${bundle}`, { signal: AbortSignal.timeout(20_000) })).text();
  for (const [, id] of js.matchAll(/method:`GET`\}\)\.handler\(\w+\(`([0-9a-f]{64})`\)/g)) {
    const vaults = await callFunction(id).catch(() => undefined);
    if (vaults) return vaults;
  }
  throw new Error("hyperliquidvaults.com: vault list function not found");
};

type StatsVault = {
  apr: number;
  summary: { name: string; vaultAddress: string; tvl: string; isClosed: boolean; relationship?: { type: string }; createTimeMillis: number };
};

export const pickVaults = async (count: number, nowMs: number, log: (msg: string, data?: Record<string, unknown>) => void): Promise<Tracked[]> => {
  try {
    const vaults = await siteVaults();
    return vaults
      .filter((v) => v.current_tvl >= 10_000)
      .sort((a, b) => b.hv_score - a.hv_score)
      .slice(0, count)
      .map((v) => ({ address: v.vault_address.toLowerCase(), source: "vault", kind: "hypercore-vault", name: v.name, accountValue: v.current_tvl, closed: false }));
  } catch (e) {
    // Approximates the site's screen: open, not a child vault, TVL ≥ $10k, at least 39 days old.
    log("hyperliquidvaults.com unavailable, using Hyperliquid's vault list", { error: (e as Error).message });
    const vaults = await getJson<StatsVault[]>("https://stats-data.hyperliquid.xyz/Mainnet/vaults", 60_000);
    return vaults
      .filter(({ summary: s }) => !s.isClosed && s.relationship?.type !== "child" && Number(s.tvl) >= 10_000 && nowMs - s.createTimeMillis >= 39 * 86_400_000)
      .sort((a, b) => Number(b.summary.tvl) - Number(a.summary.tvl))
      .slice(0, count)
      .map(({ summary: s }) => ({ address: s.vaultAddress.toLowerCase(), source: "vault", kind: "hypercore-vault", name: s.name, accountValue: Number(s.tvl), closed: false }));
  }
};

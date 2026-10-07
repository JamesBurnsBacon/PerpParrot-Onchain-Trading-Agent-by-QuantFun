// The vault half of the scan: hyperliquidvaults.com's "qualified" HyperCore vaults (~180,
// screened by TVL and age, ranked by its hv_score; primary sources) first, then the rest of Hyperliquid's own vault
// list under the same screen (open, not a child, TVL ≥ $10k, at least 39 days old). The site has no public API: its page loads the list from a TanStack server
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

export const pickVaults = async (nowMs: number, log: (msg: string, data?: Record<string, unknown>) => void): Promise<Tracked[]> => {
  const site = await siteVaults().catch((e) => {
    log("hyperliquidvaults.com unavailable, using Hyperliquid's vault list only", { error: (e as Error).message });
    return [] as SiteVault[];
  });
  const picked: Tracked[] = site
    .filter((v) => v.current_tvl >= 10_000)
    .sort((a, b) => b.hv_score - a.hv_score)
    .map((v) => ({ address: v.vault_address.toLowerCase(), source: "vault", kind: "hypercore-vault", name: v.name, accountValue: v.current_tvl, closed: false, primary: true }));
  const seen = new Set(picked.map((v) => v.address));
  const vaults = await getJson<StatsVault[]>("https://stats-data.hyperliquid.xyz/Mainnet/vaults", 60_000);
  for (const { summary: s } of vaults) {
    const address = s.vaultAddress.toLowerCase();
    if (seen.has(address) || s.isClosed || s.relationship?.type === "child" || Number(s.tvl) < 10_000 || nowMs - s.createTimeMillis < 39 * 86_400_000) continue;
    seen.add(address);
    picked.push({ address, source: "vault", kind: "hypercore-vault", name: s.name, accountValue: Number(s.tvl), closed: false, primary: false });
  }
  return picked;
};

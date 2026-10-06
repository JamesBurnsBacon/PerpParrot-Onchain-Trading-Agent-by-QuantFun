// Hyperliquid reads for the maker-share study: rate limited, and every response cached on disk so the analysis
// (and reruns) never touch the network. Offline mode throws on a cache miss.
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

const INFO_URL = "https://api.hyperliquid.xyz/info";
// HL allows 1200 weight per minute per IP; leave headroom for anything else running from this machine.
const WEIGHT_PER_MINUTE = 1000;
const BASE_WEIGHT = 20;
const ITEMS_PER_EXTRA_WEIGHT = 20; // userFills* cost one more unit per 20 items returned

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export type Client = {
  info<T>(body: Record<string, unknown>): Promise<T>;
  file<T>(url: string, name: string): Promise<T>;
  stats(): { requests: number; cacheHits: number };
};

export const createClient = (cacheDir: string, { offline = false } = {}): Client => {
  let tokens = WEIGHT_PER_MINUTE;
  let refilledAt = Date.now();
  let requests = 0;
  let cacheHits = 0;

  const take = async (weight: number) => {
    for (;;) {
      const now = Date.now();
      tokens = Math.min(WEIGHT_PER_MINUTE, tokens + ((now - refilledAt) / 60_000) * WEIGHT_PER_MINUTE);
      refilledAt = now;
      if (tokens >= weight) {
        tokens -= weight;
        return;
      }
      await sleep(((weight - tokens) / WEIGHT_PER_MINUTE) * 60_000);
    }
  };

  const cached = async <T>(path: string, load: () => Promise<T>): Promise<T> => {
    if (existsSync(path)) {
      cacheHits++;
      return JSON.parse(await readFile(path, "utf8")) as T;
    }
    if (offline) throw new Error(`not cached (offline): ${path}`);
    const value = await load();
    await mkdir(join(path, ".."), { recursive: true });
    await writeFile(path, JSON.stringify(value));
    return value;
  };

  const info = <T>(body: Record<string, unknown>): Promise<T> => {
    const key = createHash("sha256").update(JSON.stringify(body)).digest("hex").slice(0, 32);
    return cached(join(cacheDir, "info", `${body.type}-${key}.json`), async () => {
      for (let attempt = 0; ; attempt++) {
        await take(BASE_WEIGHT);
        requests++;
        const res = await fetch(INFO_URL, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(30_000),
        }).catch((error: unknown) => error as Error);
        if (res instanceof Response && res.ok) {
          const json = (await res.json()) as T;
          if (Array.isArray(json)) tokens -= Math.floor(json.length / ITEMS_PER_EXTRA_WEIGHT);
          return json;
        }
        const reason = res instanceof Response ? `HTTP ${res.status}` : res.message;
        if (attempt >= 5) throw new Error(`HL info ${body.type} failed: ${reason}`);
        await sleep(res instanceof Response && res.status === 429 ? 30_000 : 2_000 * (attempt + 1));
      }
    });
  };

  const file = <T>(url: string, name: string): Promise<T> =>
    cached(join(cacheDir, name), async () => {
      requests++;
      const res = await fetch(url, { signal: AbortSignal.timeout(300_000) });
      if (!res.ok) throw new Error(`GET ${url} failed: ${res.status}`);
      return (await res.json()) as T;
    });

  return { info, file, stats: () => ({ requests, cacheHits }) };
};

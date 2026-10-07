// Optional overlap guard for the 10-minute pick (PICK_OVERLAP_GUARD=on): read the top candidates' live
// positions, NOWNodes first (it answers clearinghouseState and costs none of the official API's
// 1,200 weight/min), and prefer candidates that don't hold the same book as one already chosen.
// Any doubt (too many failed reads, breaker open) returns null and the pick stays as Score made it.
import { positionsFromStates, type LivePosition } from "../../review/input.ts";
import { exposureOverlap } from "../../review/overlap.ts";
import { ELIGIBLE_DEXES } from "../../../shared/snapshot";
import { bulkFetch, bulkRoutingStats } from "./info-router";

const INFO_URL = "https://api.hyperliquid.xyz/info";
const MAX_FAILED_SHARE = 0.2;

export type PositionReader = (address: string) => Promise<LivePosition[]>;

export const readPositionsBulk: PositionReader = async (address) => {
  const states = await Promise.all(
    ELIGIBLE_DEXES.map(async (dex) => {
      const res = await bulkFetch(INFO_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type: "clearinghouseState", user: address, ...(dex ? { dex } : {}) }),
        signal: AbortSignal.timeout(15_000),
      });
      if (!res.ok) throw new Error(`clearinghouseState failed: ${res.status}`);
      return (await res.json()) as Parameters<typeof positionsFromStates>[0][number];
    }),
  );
  return positionsFromStates(states);
};

// Walk `ranked` best first. A candidate whose book overlaps (strictly above the threshold) with one already
// chosen is skipped; a candidate whose book is unknown is kept (no evidence is not a reason to drop it).
// If fewer than `want` are left, the skipped ones come back in rank order, so the count never shrinks.
export const pickWithoutOverlap = (ranked: readonly string[], books: ReadonlyMap<string, readonly LivePosition[] | null>, want: number, threshold: number) => {
  const picks: string[] = [];
  const skipped: string[] = [];
  for (const address of ranked) {
    if (picks.length >= want) break;
    const book = books.get(address) ?? null;
    const clash = book !== null && picks.some((p) => {
      const other = books.get(p) ?? null;
      return other !== null && exposureOverlap(book, other) > threshold;
    });
    (clash ? skipped : picks).push(address);
  }
  const toppedUp = Math.min(skipped.length, Math.max(0, want - picks.length));
  const kept = picks.concat(skipped.slice(0, toppedUp));
  return { picks: kept, excluded: skipped.slice(toppedUp), toppedUp };
};

export type GuardSummary = { pool: number; reads: number; failed: number; excluded: number; toppedUp: number; threshold: number; ms: number; provider: { nownodes: number; official: number; fallbacks: number } };

const inPool = async <T,>(items: readonly string[], size: number, fn: (item: string) => Promise<T>): Promise<T[]> => {
  const out: T[] = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(size, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]!);
    }
  }));
  return out;
};

export const overlapGuard = async (o: {
  ranked: readonly string[];
  want: number;
  threshold: number;
  read?: PositionReader;
  concurrency?: number;
  now?: () => number;
}): Promise<{ picks: string[]; excluded: string[]; summary: GuardSummary } | null> => {
  const read = o.read ?? readPositionsBulk;
  const now = o.now ?? Date.now;
  const started = now();
  if (bulkRoutingStats().breakerOpen) return null; // NOWNodes is paused: do not turn this into a burst on the official API
  const counts = () => {
    const s = bulkRoutingStats();
    return { nownodes: s.nownodes.requests, official: s.official.requests, fallbacks: s.fallbacks };
  };
  const before = counts();
  const results = await inPool(o.ranked, o.concurrency ?? 20, async (address) => {
    try {
      return await read(address);
    } catch {
      return null;
    }
  });
  const failed = results.filter((r) => r === null).length;
  if (o.ranked.length === 0 || failed / o.ranked.length > MAX_FAILED_SHARE) return null;
  const books = new Map(o.ranked.map((a, i) => [a, results[i]!] as const));
  const { picks, excluded, toppedUp } = pickWithoutOverlap(o.ranked, books, o.want, o.threshold);
  const after = counts();
  return {
    picks,
    excluded,
    summary: {
      pool: o.ranked.length,
      reads: o.ranked.length * ELIGIBLE_DEXES.length,
      failed,
      excluded: excluded.length,
      toppedUp,
      threshold: o.threshold,
      ms: now() - started,
      provider: { nownodes: after.nownodes - before.nownodes, official: after.official - before.official, fallbacks: after.fallbacks - before.fallbacks },
    },
  };
};

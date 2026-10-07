// Optional overlap guard for the 10-minute pick (PICK_OVERLAP_GUARD=on): read the top candidates' live
// positions, NOWNodes first (it answers clearinghouseState and costs none of the official API's
// 1,200 weight/min), and prefer candidates that don't hold the same book as one already chosen.
// Any doubt (a failed read, breaker open) returns null and the pick stays as Score made it.
import { positionsFromStates, type LivePosition } from "../../review/input.ts";
import { exposureOverlap } from "../../review/overlap.ts";
import { ELIGIBLE_DEXES } from "../../../shared/snapshot";
import { bulkFetch, bulkRoutingStats } from "./info-router";

const INFO_URL = "https://api.hyperliquid.xyz/info";

export type PositionReader = (address: string) => Promise<LivePosition[]>;

export const readPositionsBulk: PositionReader = async (address) => {
  // allSettled: a failed dex must not release the worker while its sibling request is still in flight.
  const settled = await Promise.allSettled(
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
  const failure = settled.find((r): r is PromiseRejectedResult => r.status === "rejected");
  if (failure) throw failure.reason;
  return positionsFromStates(settled.map((r) => (r as PromiseFulfilledResult<Parameters<typeof positionsFromStates>[0][number]>).value));
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

// Runs `fn` over `items` with at most `size` in flight. Once `halted()` is true no new item starts; the ones
// not started stay `null`.
const inPool = async <T,>(items: readonly string[], size: number, halted: () => boolean, fn: (item: string) => Promise<T>): Promise<(T | null)[]> => {
  const out: (T | null)[] = new Array(items.length).fill(null);
  let next = 0;
  const workers = Math.max(1, Math.min(Number.isFinite(size) ? Math.floor(size) : 20, items.length));
  await Promise.all(Array.from({ length: workers }, async () => {
    while (next < items.length && !halted()) {
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
  halted?: () => boolean; // default: the bulk router's circuit breaker is open (NOWNodes paused)
  now?: () => number;
}): Promise<{ picks: string[]; excluded: string[]; summary: GuardSummary } | null> => {
  const read = o.read ?? readPositionsBulk;
  const now = o.now ?? Date.now;
  const started = now();
  const halted = o.halted ?? (() => bulkRoutingStats().breakerOpen);
  if (halted()) return null; // NOWNodes is paused: do not turn this into a burst on the official API
  const counts = () => {
    const s = bulkRoutingStats();
    return { nownodes: s.nownodes.requests, official: s.official.requests, fallbacks: s.fallbacks };
  };
  const before = counts();
  const results = await inPool(o.ranked, o.concurrency ?? 20, halted, async (address) => {
    try {
      return await read(address);
    } catch {
      return null;
    }
  });
  // One missing book is enough to leave the pick as Score made it: a read that fails now and then would
  // otherwise flip exclusions (and the AI review) from one run to the next.
  const failed = results.filter((r) => r === null).length;
  if (o.ranked.length === 0 || failed > 0 || halted()) return null;
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

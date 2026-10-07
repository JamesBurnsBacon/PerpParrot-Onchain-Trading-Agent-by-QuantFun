import { describe, expect, test } from "bun:test";
import type { LivePosition } from "../review/input.ts";
import { overlapGuard, pickWithoutOverlap } from "../src/pipeline/overlap-pick";

const book = (market: string, usd = 1000): LivePosition[] => [{ market, signedNotionalUsd: usd, leverage: null, liquidationDistance: null }];
const books = (entries: [string, LivePosition[] | null][]) => new Map(entries);

describe("pickWithoutOverlap", () => {
  test("skips a candidate that holds the same book as a better one and takes the next", () => {
    const b = books([["a", book("BTC")], ["b", book("BTC", 5)], ["c", book("ETH")], ["d", book("SOL")]]);
    expect(pickWithoutOverlap(["a", "b", "c", "d"], b, 2, 0.5)).toEqual({ picks: ["a", "c"], excluded: ["b"], toppedUp: 0 });
  });

  test("keeps rank order and reports what it left out", () => {
    const b = books([["a", book("BTC")], ["b", book("BTC")], ["c", book("ETH")], ["d", book("SOL")], ["e", book("DOGE")]]);
    const r = pickWithoutOverlap(["a", "b", "c", "d", "e"], b, 3, 0.5);
    expect(r.picks).toEqual(["a", "c", "d"]);
    expect(r.excluded).toEqual(["b"]);
  });

  test("never returns fewer than asked: skipped candidates come back in rank order", () => {
    const b = books([["a", book("BTC")], ["b", book("BTC")], ["c", book("BTC")], ["d", book("ETH")]]);
    const r = pickWithoutOverlap(["a", "b", "c", "d"], b, 4, 0.5);
    expect(r.picks).toEqual(["a", "d", "b", "c"]);
    expect(r.toppedUp).toBe(2);
    expect(r.excluded).toEqual([]);
    expect(pickWithoutOverlap(["a", "b", "c"], b, 2, 0.5).picks).toEqual(["a", "b"]);
  });

  test("an unknown book is kept, and never counted as a clash for others", () => {
    const b = books([["a", null], ["b", book("BTC")], ["c", book("BTC")]]);
    expect(pickWithoutOverlap(["a", "b", "c"], b, 2, 0.5).picks).toEqual(["a", "b"]);
  });

  test("the threshold is strict: an overlap exactly at it is kept", () => {
    const half = (m: string): LivePosition[] => [...book("BTC", 500), ...book(m, 500)];
    const b = books([["a", half("ETH")], ["b", half("SOL")]]); // overlap exactly 0.5
    expect(pickWithoutOverlap(["a", "b"], b, 2, 0.5).picks).toEqual(["a", "b"]);
    expect(pickWithoutOverlap(["a", "b"], b, 1, 0.49).picks).toEqual(["a"]);
  });

  test("asking for more than the pool has returns the whole pool", () => {
    expect(pickWithoutOverlap(["a"], books([["a", book("BTC")]]), 40, 0.5).picks).toEqual(["a"]);
  });
});

describe("overlapGuard", () => {
  const ranked = Array.from({ length: 50 }, (_, i) => `0x${i}`);

  test("reads every candidate with bounded concurrency and picks without the clash", async () => {
    let inFlight = 0;
    let peak = 0;
    const read = async (a: string) => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 2));
      inFlight--;
      return a === "0x1" ? book("BTC") : a === "0x0" ? book("BTC", 3) : book(`M${a}`);
    };
    const g = await overlapGuard({ ranked, want: 40, threshold: 0.5, read, concurrency: 8 });
    expect(peak).toBeLessThanOrEqual(8);
    expect(g!.excluded).toEqual(["0x1"]);
    expect(g!.picks).toHaveLength(40);
    expect(g!.picks).not.toContain("0x1");
    expect(g!.summary).toMatchObject({ pool: 50, reads: 100, failed: 0, excluded: 1, toppedUp: 0, threshold: 0.5 });
  });

  test("gives up (null) when any read fails, so the pick stays as Score made it", async () => {
    const failing = (n: number) => async (a: string) => {
      if (Number(a.slice(2)) < n) throw new Error("down");
      return book(`M${a}`);
    };
    expect(await overlapGuard({ ranked, want: 40, threshold: 0.5, read: failing(1) })).toBeNull();
    expect(await overlapGuard({ ranked, want: 40, threshold: 0.5, read: failing(0) })).not.toBeNull();
  });

  test("stops starting reads once NOWNodes is paused, and gives up", async () => {
    let started = 0;
    const read = async () => {
      started++;
      return book("BTC");
    };
    expect(await overlapGuard({ ranked, want: 40, threshold: 0.5, read, halted: () => started >= 5, concurrency: 1 })).toBeNull();
    expect(started).toBe(5);
    expect(await overlapGuard({ ranked, want: 40, threshold: 0.5, read, halted: () => true })).toBeNull();
  });

  test("a nonsense concurrency still reads everything", async () => {
    for (const concurrency of [0, -3, Number.NaN]) {
      const g = await overlapGuard({ ranked: ["0xa", "0xb"], want: 2, threshold: 0.5, read: async (a) => book(a), concurrency });
      expect(g!.summary.failed).toBe(0);
      expect(g!.picks).toHaveLength(2);
    }
  });

  test("an empty pool is null", async () => {
    expect(await overlapGuard({ ranked: [], want: 40, threshold: 0.5, read: async () => [] })).toBeNull();
  });
});

describe("overlapGuard on the real bulk reader", () => {
  test("reads NOWNodes first and the summary counts it", async () => {
    const realFetch = globalThis.fetch;
    const saved = process.env.NOWNODES_API_KEY;
    const hosts: string[] = [];
    process.env.NOWNODES_API_KEY = "test-key";
    globalThis.fetch = (async (url: string) => {
      hosts.push(new URL(url).host);
      return Response.json({ marginSummary: { accountValue: "1" }, assetPositions: [] });
    }) as unknown as typeof fetch;
    try {
      const g = await overlapGuard({ ranked: ["0xa", "0xb", "0xc"], want: 3, threshold: 0.5 });
      expect(g!.summary.provider).toEqual({ nownodes: 6, official: 0, fallbacks: 0 }); // 3 accounts x 2 dexes
      expect(new Set(hosts)).toEqual(new Set(["hype.nownodes.io"]));
    } finally {
      globalThis.fetch = realFetch;
      if (saved === undefined) delete process.env.NOWNODES_API_KEY;
      else process.env.NOWNODES_API_KEY = saved;
    }
  });
});

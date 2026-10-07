import { describe, expect, test } from "bun:test";
import type { LivePosition } from "../review/input.ts";
import { exposureOverlap, summarizeOverlap } from "../review/overlap.ts";

const pos = (market: string, signedNotionalUsd: number): LivePosition => ({ market, signedNotionalUsd, leverage: null, liquidationDistance: null });

describe("exposureOverlap", () => {
  test("identical composition is 1, whatever the size or leverage", () => {
    expect(exposureOverlap([pos("BTC", 1000), pos("ETH", -500)], [pos("BTC", 10), pos("ETH", -5)])).toBeCloseTo(1, 10);
  });

  test("opposite directions and disjoint markets are 0", () => {
    expect(exposureOverlap([pos("BTC", 1000)], [pos("BTC", -1000)])).toBe(0);
    expect(exposureOverlap([pos("BTC", 1000)], [pos("ETH", 1000)])).toBe(0);
  });

  test("partial overlap is the sum of the smaller same-direction shares", () => {
    // a: BTC 75%, ETH 25% long. b: BTC 50% long, SOL 50% long. Overlap = min(.75,.5) = .5.
    expect(exposureOverlap([pos("BTC", 750), pos("ETH", 250)], [pos("BTC", 500), pos("SOL", 500)])).toBeCloseTo(0.5, 10);
    // a long BTC 50%, short ETH 50%. b long BTC 50%, long ETH 50%. Only BTC agrees: .5.
    expect(exposureOverlap([pos("BTC", 500), pos("ETH", -500)], [pos("BTC", 500), pos("ETH", 500)])).toBeCloseTo(0.5, 10);
  });

  test("positions on several dexes in one market add up before comparing", () => {
    expect(exposureOverlap([pos("BTC", 300), pos("BTC", 700)], [pos("BTC", 100)])).toBeCloseTo(1, 10);
    // Long and short in the same market net out to the larger side.
    expect(exposureOverlap([pos("BTC", 800), pos("BTC", -300), pos("ETH", 500)], [pos("BTC", 500), pos("ETH", 500)])).toBeCloseTo(1, 10);
  });

  test("an empty or fully netted book overlaps with nothing", () => {
    expect(exposureOverlap([], [pos("BTC", 1)])).toBe(0);
    expect(exposureOverlap([], [])).toBe(0);
    expect(exposureOverlap([pos("BTC", 100), pos("BTC", -100)], [pos("BTC", 1)])).toBe(0);
  });

  test("is symmetric and never above 1", () => {
    const a = [pos("BTC", 123.456), pos("ETH", -78.9), pos("SOL", 5)];
    const b = [pos("BTC", 50), pos("ETH", -80), pos("DOGE", 1)];
    expect(exposureOverlap(a, b)).toBe(exposureOverlap(b, a));
    expect(exposureOverlap(a, b)).toBeLessThanOrEqual(1);
  });
});

describe("summarizeOverlap", () => {
  const books = new Map<string, LivePosition[]>([
    ["0xa", [pos("BTC", 1000)]],
    ["0xb", [pos("BTC", 2000)]], // identical to a
    ["0xc", [pos("ETH", 1000)]], // disjoint
    ["0xd", []], // flat
  ]);

  test("counts pairs over the threshold and reports each account's worst partner", () => {
    const s = summarizeOverlap(["0xA", "0xB", "0xC", "0xD"], books, 0.5);
    expect(s.pairs).toBe(6);
    expect(s.above).toBe(1);
    expect(s.max).toBe(1);
    expect(s.top[0]).toEqual({ a: "0xa", b: "0xb", overlap: 1 });
    expect(s.byAddress).toEqual({ "0xa": 1, "0xb": 1, "0xc": 0, "0xd": 0 });
  });

  test("the threshold is strict: a pair exactly at it is not above", () => {
    const m = new Map<string, LivePosition[]>([["0xa", [pos("BTC", 500), pos("ETH", 500)]], ["0xb", [pos("BTC", 500), pos("SOL", 500)]]]);
    expect(summarizeOverlap(["0xa", "0xb"], m, 0.5).above).toBe(0);
    expect(summarizeOverlap(["0xa", "0xb"], m, 0.49).above).toBe(1);
  });

  test("a missing book counts as empty, and a single account has no pairs", () => {
    expect(summarizeOverlap(["0xa", "0xzz"], books, 0.5).max).toBe(0);
    const one = summarizeOverlap(["0xa"], books, 0.5);
    expect(one).toEqual({ threshold: 0.5, pairs: 0, above: 0, max: 0, top: [], byAddress: { "0xa": 0 } });
  });

  test("a pair just over the threshold counts even when its stored value rounds onto it", () => {
    // a: BTC .5000004, ETH .4999996. b: BTC .6, SOL .4. Raw overlap .5000004; stored (6 digits) .5.
    const m = new Map<string, LivePosition[]>([["0xa", [pos("BTC", 500_000.4), pos("ETH", 499_999.6)]], ["0xb", [pos("BTC", 600_000), pos("SOL", 400_000)]]]);
    const s = summarizeOverlap(["0xa", "0xb"], m, 0.5);
    expect(s.top[0]!.overlap).toBe(0.5);
    expect(s.above).toBe(1);
  });

  test("a non-finite notional is an error, not a silent empty book", () => {
    expect(() => exposureOverlap([pos("BTC", Number.NaN)], [pos("BTC", 1)])).toThrow("non-finite");
    expect(() => summarizeOverlap(["0xa", "0xb"], new Map([["0xa", [pos("BTC", Number.POSITIVE_INFINITY)]], ["0xb", [pos("BTC", 1)]]]), 0.5)).toThrow("non-finite");
  });

  test("keeps only the largest pairs, in a stable order", () => {
    const addrs = Array.from({ length: 6 }, (_, i) => `0x${i}`);
    const m = new Map(addrs.map((a) => [a, [pos("BTC", 100)]] as const));
    const s = summarizeOverlap(addrs, m, 0.5, 3);
    expect(s.top.length).toBe(3);
    expect(s.top.map((p) => `${p.a}-${p.b}`)).toEqual(["0x0-0x1", "0x0-0x2", "0x0-0x3"]);
  });
});

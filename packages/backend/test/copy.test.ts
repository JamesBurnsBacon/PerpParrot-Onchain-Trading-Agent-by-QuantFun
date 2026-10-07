import { describe, expect, test } from "bun:test";
import {
  limitPositions,
  MAX_POSITIONS,
  countedGross,
  leverageScaleE6,
  cappedNotional,
  capGrossExposure,
  computeExposures,
  decToE6,
  type WeightedSource,
} from "../../shared/copy";

const src = (address: string, weightE6: number, equityE6: string, positions: [string, string][]): WeightedSource => ({
  address,
  weightE6,
  equityE6,
  positions: positions.map(([asset, notionalE6]) => ({ asset, notionalE6 })),
});

describe("decToE6", () => {
  test("parses and truncates", () => {
    expect(decToE6("83903.112963")).toBe(83_903_112_963n);
    expect(decToE6("-1.5")).toBe(-1_500_000n);
    expect(decToE6("0.1234567")).toBe(123_456n);
    expect(decToE6("12")).toBe(12_000_000n);
  });

  test("rejects non-decimals", () => {
    expect(() => decToE6("1e5")).toThrow("not a decimal");
  });
});

describe("computeExposures", () => {
  test("weights each source's leverage per asset", () => {
    // A: 2× long BTC, weight 0.75. B: 1× short BTC + 0.5× long ETH, weight 0.25.
    const exp = computeExposures([
      src("0xa", 750_000, "1000000000", [["BTC", "2000000000"]]),
      src("0xb", 250_000, "1000000000", [["BTC", "-1000000000"], ["ETH", "500000000"]]),
    ]);
    // BTC: 0.75×2 − 0.25×1 = 1.25; ETH: 0.25×0.5 = 0.125
    expect(exp).toEqual([
      { asset: "BTC", exposureE9: 1_250_000_000n },
      { asset: "ETH", exposureE9: 125_000_000n },
    ]);
  });

  test("keeps the cash share: weights summing to 0.8 give 80% of the exposure", () => {
    const exp = computeExposures([src("0xa", 800_000, "1000000000", [["BTC", "1000000000"]])]);
    expect(exp).toEqual([{ asset: "BTC", exposureE9: 800_000_000n }]);
  });

  test("a flat wallet's exit is followed: its weight is not spread over the others", () => {
    // 0.4 + 0.4 invested; B exited, so only A's 0.4 is exposed and the rest waits as cash.
    const exp = computeExposures([
      src("0xa", 400_000, "1000000000", [["BTC", "1000000000"]]),
      src("0xb", 400_000, "1000000000", []),
    ]);
    expect(exp).toEqual([{ asset: "BTC", exposureE9: 400_000_000n }]);
  });

  test("ignores sources with zero equity", () => {
    const exp = computeExposures([
      src("0xa", 500_000, "0", [["BTC", "1000000000"]]),
      src("0xb", 500_000, "1000000000", [["ETH", "1000000000"]]),
    ]);
    expect(exp).toEqual([{ asset: "ETH", exposureE9: 500_000_000n }]);
  });

  test("is empty when every source is flat", () => {
    expect(computeExposures([src("0xa", 1_000_000, "1000000000", [])])).toEqual([]);
  });
});

describe("winding-down caps (ROSTER.md §4.4)", () => {
  test("a capped source is followed up to its cap, same sign only; perps without a cap aren't followed", () => {
    const equity = 1_000_000_000n; // $1,000
    expect(cappedNotional(800_000_000n, 500_000_000n, equity)).toBe(500_000_000n); // 0.8× held, 0.5× cap
    expect(cappedNotional(300_000_000n, 500_000_000n, equity)).toBe(300_000_000n); // under the cap: as held
    expect(cappedNotional(-900_000_000n, -400_000_000n, equity)).toBe(-400_000_000n);
    expect(cappedNotional(300_000_000n, -400_000_000n, equity)).toBe(0n); // flipped
    expect(cappedNotional(300_000_000n, undefined, equity)).toBe(0n); // a new perp
  });

  test("computeExposures applies the caps to that source only", () => {
    const capped = { ...src("0xa", 500_000, "1000000000", [["BTC", "800000000"], ["ETH", "200000000"]]), caps: new Map([["BTC", 500_000_000n]]) };
    const exp = computeExposures([capped, src("0xb", 500_000, "1000000000", [["ETH", "1000000000"]])]);
    // A: BTC capped at 0.5 × weight 0.5; its new ETH isn't followed. B: ETH 1 × 0.5.
    expect(exp).toEqual([{ asset: "BTC", exposureE9: 250_000_000n }, { asset: "ETH", exposureE9: 500_000_000n }]);
  });
});

describe("leverage normalization (owner: each wallet at 2× of its usual leverage)", () => {
  test("the scale is 2 ÷ the wallet's 30-day average, floored at 0.05×; unknown leaves the wallet as it is", () => {
    expect(leverageScaleE6(0.1)).toBe("20000000"); // a 0.1× vault: ×20
    expect(leverageScaleE6(4)).toBe("500000"); // a 4× trader: ×0.5
    expect(leverageScaleE6(0.01)).toBe("40000000"); // floored at 0.05×: ×40, not ×200
    expect(leverageScaleE6(0)).toBe("40000000");
    expect(leverageScaleE6(null)).toBeNull();
    expect(leverageScaleE6(Number.NaN)).toBeNull();
  });

  test("a usual day: a 0.1× vault and a 4× trader each count at 2× per unit of weight", () => {
    const vault = { ...src("0xa", 500_000, "1000000000", [["BTC", "100000000"]]), scaleE6: 20_000_000n, maxGrossE9: 5_000_000_000n };
    const trader = { ...src("0xb", 500_000, "1000000000", [["ETH", "-4000000000"]]), scaleE6: 500_000n, maxGrossE9: 5_000_000_000n };
    expect(computeExposures([vault, trader])).toEqual([{ asset: "BTC", exposureE9: 1_000_000_000n }, { asset: "ETH", exposureE9: -1_000_000_000n }]);
  });

  test("a wallet above its usual leverage moves us up, but never counts past the gross cap on its own", () => {
    // The vault triples to 0.3×: 0.3 × 20 = 6×, capped at 5×; × weight 0.5 = 2.5.
    const vault = { ...src("0xa", 500_000, "1000000000", [["BTC", "300000000"]]), scaleE6: 20_000_000n, maxGrossE9: 5_000_000_000n };
    expect(computeExposures([vault])).toEqual([{ asset: "BTC", exposureE9: 2_500_000_000n }]);
    // Halving its leverage halves our exposure: its de-risking is still a signal.
    const calmer = { ...vault, positions: [{ asset: "BTC", notionalE6: "50000000" }] };
    expect(computeExposures([calmer])).toEqual([{ asset: "BTC", exposureE9: 500_000_000n }]);
  });
});

describe("at most 15 positions (owner: the book holds 5–15 perps)", () => {
  const e = (asset: string, exposureE9: bigint) => ({ asset, exposureE9 });

  test("15 or fewer perps are left as they are", () => {
    const few = Array.from({ length: MAX_POSITIONS }, (_, i) => e(`P${String(i).padStart(2, "0")}`, BigInt(i + 1) * 10_000_000n));
    expect(limitPositions(few)).toBe(few);
  });

  test("keeps the 15 largest by |exposure| and scales them so the counted gross is unchanged", () => {
    // 20 perps: 15 longs of 0.1× and 5 small shorts of −0.02×.
    const many = [
      ...Array.from({ length: 15 }, (_, i) => e(`L${String(i).padStart(2, "0")}`, 100_000_000n)),
      ...Array.from({ length: 5 }, (_, i) => e(`S${i}`, -20_000_000n)),
    ];
    const kept = limitPositions(many);
    expect(kept).toHaveLength(15);
    expect(kept.every((k) => k.asset.startsWith("L"))).toBe(true);
    // Before: 1.5 long + ½ × 0.1 short = 1.55×; after: the 15 longs scaled to 1.55× in total.
    expect(countedGross(kept.map((k) => k.exposureE9))).toBe(countedGross(many.map((m) => m.exposureE9)) - 5n); // integer rounding only
    expect(kept[0]!.exposureE9).toBe(103_333_333n);
  });

  test("ties at the edge are broken by perp name, so the cut is deterministic", () => {
    const tied = Array.from({ length: 16 }, (_, i) => e(`T${String(15 - i).padStart(2, "0")}`, 50_000_000n));
    expect(limitPositions(tied).map((k) => k.asset)).toEqual(Array.from({ length: 15 }, (_, i) => `T${String(i).padStart(2, "0")}`));
  });
});

describe("capGrossExposure", () => {
  const exposures = [
    { asset: "BTC", exposureE9: 3_000_000_000n },
    { asset: "ETH", exposureE9: -1_000_000_000n },
  ];

  test("counts the minority side at half: offsetting longs and shorts are partly hedged", () => {
    expect(countedGross([3_000_000_000n, -1_000_000_000n])).toBe(3_500_000_000n); // 3 + ½ × 1
    expect(countedGross([3_000_000_000n, -2_000_000_000n])).toBe(4_000_000_000n); // 3 + ½ × 2
    expect(countedGross([-3_000_000_000n, 1_000_000_000n, 1_000_000_000n])).toBe(4_000_000_000n); // short majority
    expect(countedGross([2_000_000_000n, 3_000_000_000n])).toBe(5_000_000_000n); // all long: in full
    expect(countedGross([2_000_000_000n, -2_000_000_000n])).toBe(3_000_000_000n); // balanced
  });

  test("scales pro-rata when the counted gross exceeds the cap", () => {
    // Counted 3.5× capped at 1.75× → halve everything.
    expect(capGrossExposure(exposures, 1_750_000_000n)).toEqual([
      { asset: "BTC", exposureE9: 1_500_000_000n },
      { asset: "ETH", exposureE9: -500_000_000n },
    ]);
  });

  test("leaves exposures under the cap untouched: long BTC / short ETH fits where long both wouldn't", () => {
    expect(capGrossExposure(exposures, 3_500_000_000n)).toBe(exposures); // raw gross 4×, counted 3.5×
    const both = [{ asset: "BTC", exposureE9: 3_000_000_000n }, { asset: "ETH", exposureE9: 1_000_000_000n }];
    expect(capGrossExposure(both, 3_500_000_000n)).not.toBe(both);
  });

  test("preserves signs and never exceeds the cap across generated signed exposures", () => {
    let seed = 0x51a7e;
    const next = (): number => {
      seed = (Math.imul(seed, 1_664_525) + 1_013_904_223) >>> 0;
      return seed;
    };
    const grossOf = (items: { exposureE9: bigint }[]): bigint => countedGross(items.map((item) => item.exposureE9));

    for (let sample = 0; sample < 250; sample++) {
      const input = Array.from({ length: 1 + next() % 8 }, (_, index) => ({
        asset: `ASSET-${index}`,
        exposureE9: BigInt(next() % 200_001 - 100_000),
      }));
      const inputGross = grossOf(input);
      const cap = BigInt(next() % (Number(inputGross) + 1));
      const output = capGrossExposure(input, cap);

      expect(grossOf(output)).toBeLessThanOrEqual(cap);
      output.forEach((item, index) => {
        expect(item.exposureE9 === 0n || (item.exposureE9 < 0n) === (input[index].exposureE9 < 0n)).toBe(true);
        expect(item.exposureE9 < 0n ? -item.exposureE9 : item.exposureE9)
          .toBeLessThanOrEqual(input[index].exposureE9 < 0n ? -input[index].exposureE9 : input[index].exposureE9);
      });
    }
  });
});


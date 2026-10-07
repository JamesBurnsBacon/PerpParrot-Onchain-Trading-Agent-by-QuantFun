import { describe, expect, test } from "bun:test";
import {
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

describe("capGrossExposure", () => {
  const exposures = [
    { asset: "BTC", exposureE9: 3_000_000_000n },
    { asset: "ETH", exposureE9: -1_000_000_000n },
  ];

  test("scales pro-rata when gross exceeds the cap", () => {
    // Gross 4× capped at 2× → halve everything.
    expect(capGrossExposure(exposures, 2_000_000_000n)).toEqual([
      { asset: "BTC", exposureE9: 1_500_000_000n },
      { asset: "ETH", exposureE9: -500_000_000n },
    ]);
  });

  test("leaves exposures under the cap untouched", () => {
    expect(capGrossExposure(exposures, 5_000_000_000n)).toBe(exposures);
  });

  test("preserves signs and never exceeds the cap across generated signed exposures", () => {
    let seed = 0x51a7e;
    const next = (): number => {
      seed = (Math.imul(seed, 1_664_525) + 1_013_904_223) >>> 0;
      return seed;
    };
    const grossOf = (items: { exposureE9: bigint }[]): bigint =>
      items.reduce((sum, item) => sum + (item.exposureE9 < 0n ? -item.exposureE9 : item.exposureE9), 0n);

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


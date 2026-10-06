import { describe, expect, test } from "bun:test";
import {
  capGrossExposure,
  checkActiveCeilings,
  computeExposures,
  decToE6,
  deviationBps,
  toTargetE6,
  type WeightedSource,
} from "../../shared/copy";

const src = (address: string, weightE6: number, equityE6: string, positions: [string, string][], ceilingE6 = 1_000_000): WeightedSource => ({
  address,
  weightE6,
  ceilingE6,
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

  test("redistributes flat sources' weight over active ones, cash unchanged", () => {
    // 0.4 + 0.4 invested (0.2 cash); B is flat, so A carries the full 0.8.
    const exp = computeExposures([
      src("0xa", 400_000, "1000000000", [["BTC", "1000000000"]]),
      src("0xb", 400_000, "1000000000", []),
    ]);
    expect(exp).toEqual([{ asset: "BTC", exposureE9: 800_000_000n }]);
  });

  test("ignores sources with zero equity", () => {
    const exp = computeExposures([
      src("0xa", 500_000, "0", [["BTC", "1000000000"]]),
      src("0xb", 500_000, "1000000000", [["ETH", "1000000000"]]),
    ]);
    expect(exp).toEqual([{ asset: "ETH", exposureE9: 1_000_000_000n }]);
  });

  test("is empty when every source is flat", () => {
    expect(computeExposures([src("0xa", 1_000_000, "1000000000", [])])).toEqual([]);
  });

  test("toTargetE6 scales by our equity", () => {
    expect(toTargetE6(1_250_000_000n, 470_000_000n)).toBe(587_500_000n);
  });
});

describe("checkActiveCeilings", () => {
  test("allows renormalization within the ceilings", () => {
    // 0.2 + 0.2 invested; B flat → A carries 0.4, ceiling 0.4.
    expect(() =>
      checkActiveCeilings([src("0xa", 200_000, "1000000000", [["BTC", "1"]], 400_000), src("0xb", 200_000, "1000000000", [], 400_000)]),
    ).not.toThrow();
  });

  test("rejects renormalization that pushes a source past its ceiling", () => {
    expect(() =>
      checkActiveCeilings([src("0xa", 200_000, "1000000000", [["BTC", "1"]], 250_000), src("0xb", 200_000, "1000000000", [], 250_000)]),
    ).toThrow("active-source concentration exceeds ceiling: 0xa");
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
});

describe("deviationBps", () => {
  const snap = src("0xa", 1, "10000000000", [["BTC", "1000000000"], ["ETH", "-500000000"]]);

  test("measures total notional drift against live equity", () => {
    const live = { equityE6: 10_000_000_000n, positions: new Map([["BTC", 1_100_000_000n], ["ETH", -500_000_000n]]) };
    expect(deviationBps(snap, live)).toBe(100); // 100 / 10,000 = 1%
  });

  test("counts positions missing on either side", () => {
    const live = { equityE6: 10_000_000_000n, positions: new Map([["SOL", 100_000_000n]]) };
    expect(deviationBps(snap, live)).toBe(1_600); // (1000 + 500 + 100) / 10,000
  });

  test("catches an equity mismatch even when positions agree", () => {
    const live = { equityE6: 9_000_000_000n, positions: new Map([["BTC", 1_000_000_000n], ["ETH", -500_000_000n]]) };
    expect(deviationBps(snap, live)).toBe(1_111); // |10,000 − 9,000| / 9,000
  });

  test("treats zero live equity as a full mismatch", () => {
    expect(deviationBps(snap, { equityE6: 0n, positions: new Map() })).toBe(10_000);
  });
});

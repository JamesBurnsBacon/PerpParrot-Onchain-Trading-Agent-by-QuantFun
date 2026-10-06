import { describe, expect, test } from "bun:test";
import { capGrossExposure, computeExposures, decToE6, deviationBps, parseAccount, toTargetE6, type WeightedSource } from "../../shared/copy";

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

describe("parseAccount", () => {
  test("sums equity across dexes and signs notionals, keeping eligible assets only", () => {
    const core = {
      marginSummary: { accountValue: "1000.5" },
      assetPositions: [
        { position: { coin: "BTC", szi: "0.01", positionValue: "850.0" } },
        { position: { coin: "ETH", szi: "-0.1", positionValue: "300.0" } },
        { position: { coin: "DOGE", szi: "100", positionValue: "20.0" } },
      ],
    };
    const xyz = {
      marginSummary: { accountValue: "200" },
      assetPositions: [{ position: { coin: "xyz:MSFT", szi: "-1", positionValue: "450.25" } }],
    };
    const acct = parseAccount([core, xyz], new Set(["BTC", "ETH", "xyz:MSFT"]));
    expect(acct.equityE6).toBe(1_200_500_000n);
    expect(Object.fromEntries(acct.positions)).toEqual({ BTC: 850_000_000n, ETH: -300_000_000n, "xyz:MSFT": -450_250_000n });
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
  const snap = src("0xa", 1, "0", [["BTC", "1000000000"], ["ETH", "-500000000"]]);

  test("measures total notional drift against live equity", () => {
    const live = { equityE6: 10_000_000_000n, positions: new Map([["BTC", 1_100_000_000n], ["ETH", -500_000_000n]]) };
    expect(deviationBps(snap, live)).toBe(100); // 100 / 10,000 = 1%
  });

  test("counts positions missing on either side", () => {
    const live = { equityE6: 1_000_000_000n, positions: new Map([["SOL", 100_000_000n]]) };
    expect(deviationBps(snap, live)).toBe(16_000); // (1000 + 500 + 100) / 1000
  });

  test("treats zero live equity as a full mismatch", () => {
    expect(deviationBps(snap, { equityE6: 0n, positions: new Map() })).toBe(10_000);
  });
});

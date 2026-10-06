import { describe, expect, test } from "bun:test";
import { computeExposures, decToE6, deviationBps, parseAccount, toTargetE6 } from "../../shared/copy";
import type { SnapshotSource } from "../../shared/snapshot";
import { eligibleFromMeta } from "../src/eligibility";
import { frozenSetHash } from "../src/snapshot";
import frozenSet from "../fixtures/frozen-set.json";

const src = (address: string, weightE6: number, equityE6: string, positions: [string, string][]): SnapshotSource => ({
  address: address as `0x${string}`,
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

  test("renormalizes weights over sources that hold positions", () => {
    const exp = computeExposures([
      src("0xa", 500_000, "1000000000", [["BTC", "1000000000"]]),
      src("0xb", 500_000, "1000000000", []),
    ]);
    // A is the only active source, so it gets the full weight: 1× BTC.
    expect(exp).toEqual([{ asset: "BTC", exposureE9: 1_000_000_000n }]);
  });

  test("is empty when every source is flat", () => {
    expect(computeExposures([src("0xa", 1_000_000, "1000000000", [])])).toEqual([]);
  });

  test("toTargetE6 scales by our equity", () => {
    expect(toTargetE6(1_250_000_000n, 470_000_000n)).toBe(587_500_000n);
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

describe("eligibleFromMeta", () => {
  const meta = (collateralToken: number) => ({
    collateralToken,
    universe: [
      { name: "BTC", maxLeverage: 40 },
      { name: "OLD", maxLeverage: 10, isDelisted: true },
      { name: "xyz:HOOD", maxLeverage: 10, onlyIsolated: true, marginMode: "noCross" },
      { name: "io:ANTH", maxLeverage: 10, marginMode: "strictIsolated" },
      { name: "SMALL", maxLeverage: 10 },
    ],
  });
  const ctxs = [
    { openInterest: "1000", markPx: "85000" },
    { openInterest: "1e9", markPx: "1" },
    { openInterest: "1e9", markPx: "1" },
    { openInterest: "1e9", markPx: "1" },
    { openInterest: "100", markPx: "1000" },
  ];

  test("keeps listed cross-margin USDC markets with ≥ $20M OI", () => {
    expect(eligibleFromMeta([meta(0), ctxs])).toEqual(["BTC"]);
  });

  test("skips dexes with non-USDC collateral", () => {
    expect(eligibleFromMeta([meta(1), ctxs])).toEqual([]);
  });
});

describe("frozenSetHash", () => {
  test("is order-independent and matches the mirror config", () => {
    const set = frozenSet.sources as { address: `0x${string}`; weightE6: number }[];
    expect(frozenSetHash([...set].reverse())).toBe(frozenSetHash(set));
    expect(frozenSetHash(set)).toBe("0xf169c1cec9f53dbc068305c9147d11410e7b5ced85363fe994ad191e411e4a32");
  });
});

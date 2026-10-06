import { describe, expect, test } from "bun:test";
import { portfolioEquityE6, positionsOf, readAccountState, type PortfolioResponse } from "../../shared/account";

const portfolio = (values: string[]): PortfolioResponse => [
  ["allTime", { accountValueHistory: [[1, "1"]] }],
  ["day", { accountValueHistory: values.map((v, i) => [i, v] as [number, string]) }],
];

describe("positionsOf", () => {
  test("merges dexes, signs notionals and keeps eligible assets only", () => {
    const core = {
      assetPositions: [
        { position: { coin: "BTC", szi: "0.01", positionValue: "850.0" } },
        { position: { coin: "ETH", szi: "-0.1", positionValue: "300.0" } },
        { position: { coin: "DOGE", szi: "100", positionValue: "20.0" } },
      ],
    };
    const xyz = { assetPositions: [{ position: { coin: "xyz:MSFT", szi: "-1", positionValue: "450.25" } }] };
    expect(Object.fromEntries(positionsOf([core, xyz], new Set(["BTC", "ETH", "xyz:MSFT"])))).toEqual({
      BTC: 850_000_000n,
      ETH: -300_000_000n,
      "xyz:MSFT": -450_250_000n,
    });
  });
});

describe("portfolioEquityE6", () => {
  test("takes the latest point of the day window", () => {
    expect(portfolioEquityE6(portfolio(["100", "62053.123456789"]))).toBe(62_053_123_456n);
  });

  test("fails without a day history", () => {
    expect(() => portfolioEquityE6([["week", { accountValueHistory: [[1, "1"]] }]])).toThrow("no day history");
    expect(() => portfolioEquityE6(portfolio([]))).toThrow("no day history");
  });
});

describe("readAccountState", () => {
  test("combines positions with portfolio equity", () => {
    const state = readAccountState(
      [{ assetPositions: [{ position: { coin: "BTC", szi: "1", positionValue: "100" } }] }],
      portfolio(["1000"]),
      new Set(["BTC"]),
    );
    expect(state).toEqual({ equityE6: 1_000_000_000n, positions: new Map([["BTC", 100_000_000n]]) });
  });
});

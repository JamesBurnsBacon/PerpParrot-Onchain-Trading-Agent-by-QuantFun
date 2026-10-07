import { describe, expect, test } from "bun:test";
import { accrueFunding, equityOf, newBook, recordMarks, stepBtcBook, stepCopyBook, type Market, type PaperConfig } from "../src/paper/book";

const cfg: PaperConfig = { minOrderUsd: 10, driftFraction: 0.1, equityBandFraction: 0, marginCap: 0.95, slippageBps: 0 };
const markets = (btc = 100_000, eth = 4_000) =>
  new Map<string, Market>([
    ["BTC", { markPx: btc, maxLeverage: 40, feeBps: 0 }],
    ["ETH", { markPx: eth, maxLeverage: 25, feeBps: 0 }],
  ]);

describe("stepCopyBook: confirmed closes and the equity band", () => {
  test("keeps a position while its close is pending, closes it once confirmed", () => {
    const book = newBook("a", "A", "copy", 1_000, 0);
    stepCopyBook(book, new Map([["BTC", 1]]), markets(), cfg);
    stepCopyBook(book, new Map(), markets(), cfg, new Set(["BTC"]));
    expect(book.positions.BTC.szi).toBeCloseTo(0.01, 9);
    stepCopyBook(book, new Map(), markets(), cfg);
    expect(book.positions.BTC).toBeUndefined();
  });

  test("a bucket's equity band scales with its multiplier, so it trades like Aggressive scaled down", () => {
    // $1,000 equity, 5% band: Aggressive (×1) skips a $40 gap; Conservative (×0.25) needs only $12.50.
    const aggressive = newBook("a", "A", "copy", 1_000, 0);
    const conservative = newBook("c", "C", "copy", 1_000, 0, 0.25);
    stepCopyBook(conservative, new Map([["ETH", 0.4]]), markets(), cfg); // $100 at ×0.25
    stepCopyBook(conservative, new Map([["ETH", 0.6]]), markets(), { ...cfg, equityBandFraction: 0.05 }); // → $150: a $50 gap > $12.50
    expect(conservative.positions.ETH.szi).toBeCloseTo(0.0375, 9);
    stepCopyBook(aggressive, new Map([["ETH", 0.1]]), markets(), cfg);
    stepCopyBook(aggressive, new Map([["ETH", 0.14]]), markets(), { ...cfg, equityBandFraction: 0.05 }); // $40 gap < $50
    expect(aggressive.positions.ETH.szi).toBeCloseTo(0.025, 9);
  });

  test("skips gaps under the equity share", () => {
    const book = newBook("a", "A", "copy", 1_000, 0);
    stepCopyBook(book, new Map([["ETH", 0.1]]), markets(), cfg);
    // $100 → $140: over 10% and $10, but under 5% of $1,000.
    stepCopyBook(book, new Map([["ETH", 0.14]]), markets(), { ...cfg, equityBandFraction: 0.05 });
    expect(book.positions.ETH.szi).toBeCloseTo(0.025, 9);
    stepCopyBook(book, new Map([["ETH", 0.14]]), markets(), cfg);
    expect(book.positions.ETH.szi).toBeCloseTo(0.035, 9);
  });
});

describe("stepCopyBook", () => {
  test("opens targets as fractions of equity", () => {
    const book = newBook("a", "A", "copy", 1_000, 0);
    stepCopyBook(book, new Map([["BTC", 1.5], ["ETH", -0.5]]), markets(), cfg);
    expect(book.positions.BTC.szi).toBeCloseTo(0.015, 9); // $1,500
    expect(book.positions.ETH.szi).toBeCloseTo(-0.125, 9); // −$500
    expect(equityOf(book, markets())).toBeCloseTo(1_000, 6);
  });

  test("marks to market and realizes PnL when reducing", () => {
    const book = newBook("a", "A", "copy", 1_000, 0);
    stepCopyBook(book, new Map([["BTC", 1]]), markets(100_000), cfg);
    // BTC +10%: equity 1,100. Target exposure 0 → close, realizing +$100.
    expect(equityOf(book, markets(110_000))).toBeCloseTo(1_100, 6);
    stepCopyBook(book, new Map(), markets(110_000), cfg);
    expect(book.positions.BTC).toBeUndefined();
    expect(book.cashUsd).toBeCloseTo(1_100, 6);
  });

  test("pays fees and slippage on every fill", () => {
    const book = newBook("a", "A", "copy", 1_000, 0);
    const m = new Map<string, Market>([["BTC", { markPx: 100_000, maxLeverage: 40, feeBps: 4.5 }]]);
    stepCopyBook(book, new Map([["BTC", 1]]), m, { ...cfg, slippageBps: 5 });
    // Bought $1,000 at mark + 5 bps, fee 4.5 bps of ~$1,000.
    expect(book.feesUsd).toBeCloseTo(0.45, 2);
    expect(equityOf(book, m)).toBeLessThan(1_000);
  });

  test("skips legs under the $10 minimum and within the drift band", () => {
    const small = newBook("s", "S", "copy", 470, 0);
    stepCopyBook(small, new Map([["ETH", 0.02]]), markets(), cfg); // $9.40
    expect(small.positions.ETH).toBeUndefined();
    const book = newBook("a", "A", "copy", 1_000, 0);
    stepCopyBook(book, new Map([["BTC", 1]]), markets(), cfg);
    const trades = book.trades;
    stepCopyBook(book, new Map([["BTC", 1.05]]), markets(), cfg); // 5% drift
    expect(book.trades).toBe(trades);
  });

  test("the same exposures at $10k trade legs the $470 book can't", () => {
    const exposures = new Map([["BTC", 0.5], ["ETH", 0.015]]);
    const small = newBook("s", "S", "copy", 470, 0);
    const big = newBook("b", "B", "copy", 10_000, 0);
    stepCopyBook(small, exposures, markets(), cfg);
    stepCopyBook(big, exposures, markets(), cfg);
    expect(Object.keys(small.positions)).toEqual(["BTC"]); // ETH leg $7.05 < $10
    expect(Object.keys(big.positions).sort()).toEqual(["BTC", "ETH"]);
  });

  test("applies the multiplier (Balanced = Aggressive × m)", () => {
    const book = newBook("b", "B", "copy", 1_000, 0, 0.5);
    stepCopyBook(book, new Map([["BTC", 2]]), markets(), cfg);
    expect(book.positions.BTC.szi * 100_000).toBeCloseTo(1_000, 6);
  });

  test("scales everything down when margin would exceed 95% of equity", () => {
    const book = newBook("a", "A", "copy", 100, 0);
    const m = new Map<string, Market>([["X", { markPx: 1, maxLeverage: 1, feeBps: 0 }]]);
    stepCopyBook(book, new Map([["X", 2]]), m, cfg);
    expect(book.positions.X.szi).toBeCloseTo(95, 6);
  });

  test("flipping a position realizes the old leg and opens at the new price", () => {
    const book = newBook("a", "A", "copy", 1_000, 0);
    stepCopyBook(book, new Map([["BTC", 1]]), markets(100_000), cfg);
    stepCopyBook(book, new Map([["BTC", -1]]), markets(105_000), cfg);
    expect(book.positions.BTC.szi).toBeLessThan(0);
    expect(book.positions.BTC.entryPx).toBe(105_000);
    expect(book.cashUsd).toBeCloseTo(1_050, 6);
  });
});

describe("stepBtcBook", () => {
  test("buys once and holds", () => {
    const book = newBook("btc", "BTC", "btc", 1_000, 0);
    stepBtcBook(book, markets(100_000), cfg);
    stepBtcBook(book, markets(120_000), cfg);
    expect(book.trades).toBe(1);
    expect(equityOf(book, markets(120_000))).toBeCloseTo(1_200, 6);
  });
});

describe("funding and missing markets", () => {
  test("longs pay positive funding, shorts receive it, pro rata to the hours held", () => {
    const book = newBook("f", "F", "copy", 1_000, 0);
    stepCopyBook(book, new Map([["BTC", 1], ["ETH", -0.5]]), markets(), cfg);
    const m = new Map<string, Market>([
      ["BTC", { markPx: 100_000, maxLeverage: 40, feeBps: 0, fundingRate: 0.0001 }],
      ["ETH", { markPx: 4_000, maxLeverage: 25, feeBps: 0, fundingRate: 0.0001 }],
    ]);
    accrueFunding(book, m, 0.5);
    // Long $1,000 pays 0.01% × 0.5 h = $0.05; short $500 receives $0.025.
    expect(book.fundingUsd).toBeCloseTo(0.025, 9);
    expect(equityOf(book, m)).toBeCloseTo(1_000 - 0.025, 9);
  });

  test("a market that disappears keeps its last mark, not its entry", () => {
    const book = newBook("g", "G", "copy", 1_000, 0);
    stepCopyBook(book, new Map([["BTC", 1]]), markets(100_000), cfg);
    recordMarks(book, markets(110_000));
    expect(equityOf(book, new Map())).toBeCloseTo(1_100, 6);
  });
});

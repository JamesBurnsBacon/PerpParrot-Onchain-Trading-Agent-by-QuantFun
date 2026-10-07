import { describe, expect, test } from "bun:test";
import { episodesFromFills, executionCoverage, executionFit, exposureOverlap, holdMinutes, holdouts, measure, timeInMarket, type HlFill } from "../src/pipeline/evidence";
import type { ScoreInput } from "../src/score";

const H = 3_600_000;
const DAY = 24 * H;
const NOW = Date.parse("2026-10-07T12:00:00Z");
const START = NOW - 30 * DAY;

const fill = (coin: string, time: number, side: "B" | "A", sz: number, startPosition: number, px = 100, oid = time): HlFill => ({
  coin, oid, px: String(px), sz: String(sz), side, startPosition: String(startPosition), crossed: true, time,
});

describe("holding episodes", () => {
  test("open → close, a flip closes and reopens, spot fills ignored", () => {
    const fills = [
      fill("BTC", NOW - 10 * H, "B", 1, 0), // open long
      fill("BTC", NOW - 8 * H, "A", 1, 1), // close: 2 h
      fill("ETH", NOW - 6 * H, "A", 2, 0), // open short
      fill("ETH", NOW - 5 * H, "B", 3, -2), // flip to long: short held 1 h
      fill("ETH", NOW - 2 * H, "A", 1, 1), // close long: 3 h
      fill("@107", NOW - 1 * H, "B", 5, 0), // spot
    ];
    const episodes = episodesFromFills(fills, START);
    expect(episodes).toHaveLength(3);
    expect(holdMinutes(episodes, NOW)).toBe(120); // median of 120, 60, 180
    expect(timeInMarket(episodes, false, START, NOW)).toBeCloseTo((2 * H + 4 * H) / (30 * DAY));
  });

  test("a position open at the window start is carried in and its hold is a lower bound", () => {
    const episodes = episodesFromFills([fill("SOL", NOW - 2 * DAY, "B", 1, 3)], START);
    expect(episodes).toEqual([{ coin: "SOL", open: START, close: null, carriedIn: true }]);
    expect(holdMinutes(episodes, NOW)).toBe(30 * 24 * 60);
  });
});

describe("holdouts", () => {
  // A month history every 12 h: PnL up $10 a point on ~$1,000 (one flat point), no flows.
  const points = Array.from({ length: 60 }, (_, i) => NOW - 30 * DAY + i * 12 * H);
  const pnl: number[] = [];
  points.forEach((_, i) => pnl.push(i === 0 ? 0 : pnl[i - 1]! + (i === 40 ? 0 : 10)));
  const input = {
    address: "0x1", kind: "trader", accountValue: 1000, closed: false, history: null, tradeCount: 50,
    month: { accountValueHistory: points.map((t, i) => [t, 1000 + pnl[i]!] as const), pnlHistory: points.map((t, i) => [t, pnl[i]!] as const) },
    allTime: null,
  } as unknown as ScoreInput;

  test("two trailing 7-day windows, Score's daily ratios, same-sign windows are stable", () => {
    const h = holdouts(input, NOW);
    expect(h.oosWindows).toBe(2);
    expect(h.oosSharpe).toBeGreaterThan(0);
    expect(h.oosMaxDrawdown).toBe(0);
    expect(h.crossWindowStability).toBeGreaterThan(0.8);
  });

  test("no month history: no windows, all unknown", () => {
    expect(holdouts({ ...input, month: null }, NOW)).toEqual({ oosWindows: 0, oosSharpe: null, oosSortino: null, oosMaxDrawdown: null, crossWindowStability: null });
  });
});

describe("execution", () => {
  test("coverage is the tradable share of traded notional", () => {
    const fills = [fill("BTC", NOW - H, "B", 1, 0, 300), fill("TINY", NOW - H, "B", 1, 0, 100)];
    expect(executionCoverage(fills, [], new Set(["BTC"]))).toBeCloseTo(0.75);
    expect(executionCoverage([], [], new Set(["BTC"]))).toBeNull();
  });

  test("fit: the share of a hold a copy 10 minutes late catches; busy traders lose up to half", () => {
    expect(executionFit(1, 10, 5)).toBe(0);
    expect(executionFit(1, 60, 5)).toBe(83);
    expect(executionFit(1, 1000, 100)).toBe(50);
    expect(executionFit(0.5, 1000, 5)).toBe(50);
    expect(executionFit(null, 360, 5)).toBeNull();
  });

  test("overlap: same-sign shares of each book; opposite sides and flat books share nothing", () => {
    const pos = (market: string, signedNotionalUsd: number) => ({ market, signedNotionalUsd, leverage: null, liquidationDistance: null });
    expect(exposureOverlap([pos("BTC", 60), pos("ETH", 40)], [pos("BTC", 30), pos("SOL", 70)])).toBeCloseTo(0.3);
    expect(exposureOverlap([pos("BTC", 60)], [pos("BTC", -60)])).toBe(0);
    expect(exposureOverlap([], [pos("BTC", 60)])).toBe(0);
  });
});

test("measure: a source holding one position all month with no fills", () => {
  const input = { address: "0x1", kind: "trader", accountValue: 1000, closed: false, history: null, tradeCount: 0, month: null, allTime: null } as unknown as ScoreInput;
  const m = measure({ input, fills: [], positions: [{ market: "BTC", signedNotionalUsd: 2000, leverage: 5, liquidationDistance: 0.4 }], eligible: new Set(["BTC"]), nowMs: NOW });
  expect(m.medianHoldMinutes).toBe(30 * 24 * 60);
  expect(m.timeInMarket).toBe(1);
  expect(m.executionCoverage).toBe(1);
  expect(m.executionFit).toBe(100); // 1 − 10 / 43,200 rounds to 100
  expect(m.concentration).toBe(1);
  expect(m.liquidationDistance).toBe(0.4);
  expect(m.averageLeverage).toBeNull(); // no month history to sample
});

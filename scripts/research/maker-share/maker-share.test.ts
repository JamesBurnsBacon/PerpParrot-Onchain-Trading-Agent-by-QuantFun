// bun test scripts/research/maker-share
import { describe, expect, test } from "bun:test";
import { DAY_MS, isPerp, makerStats, performance, windowPoints, type Fill } from "./features";
import { bootstrap, mannWhitney, ols, ranks, rng, spearman, spearmanPermutation } from "./stats";

const fill = (coin: string, px: number, sz: number, crossed: boolean, fee = 0): Fill =>
  ({ coin, px: String(px), sz: String(sz), crossed, fee: String(fee), closedPnl: "0", time: 0 });

describe("features", () => {
  test("isPerp keeps validator and HIP-3 perps, drops spot", () => {
    expect(["BTC", "xyz:MSFT", "kPEPE"].every(isPerp)).toBe(true);
    expect(["@107", "PURR/USDC"].some(isPerp)).toBe(false);
  });

  test("maker share is notional-weighted and ignores spot", () => {
    const s = makerStats([
      fill("BTC", 100, 3, false, -0.03), // maker, 300
      fill("ETH", 10, 10, true, 0.045), // taker, 100
      fill("@107", 1, 1000, false), // spot, ignored
    ]);
    expect(s.fills).toBe(2);
    expect(s.makerShare).toBeCloseTo(0.75);
    expect(s.makerShareByCount).toBeCloseTo(0.5);
    expect(s.feeRate).toBeCloseTo(0.015 / 400);
  });

  test("no perp fills gives null shares", () => {
    expect(makerStats([fill("@1", 1, 1, true)]).makerShare).toBeNull();
  });

  test("performance backs flows out of PnL", () => {
    // +10% trading each day; a 1000 deposit on day 2 must not count as return.
    const points = [
      { ts: 0, accountValue: 1000, pnl: 0 },
      { ts: DAY_MS, accountValue: 1100, pnl: 100 },
      { ts: 2 * DAY_MS, accountValue: 2210, pnl: 210 },
    ];
    const p = performance(points)!;
    expect(p.totalReturn).toBeCloseTo(1.1 * (1 + 110 / 2100) - 1, 6);
    expect(p.maxDrawdown).toBe(0);
    expect(p.days).toBe(2);
  });

  test("performance measures drawdown on the compounded curve", () => {
    const points = [0, 100, -400, -300].map((pnl, i) => ({ ts: i * DAY_MS, accountValue: 1000 + pnl, pnl }));
    expect(performance(points)!.maxDrawdown).toBeCloseTo(5 / 11, 6); // 1100 → 600, then +100
  });

  test("windowPoints joins histories on shared timestamps within the range", () => {
    const w = {
      accountValueHistory: [[0, 10], [1, 11], [2, 12], [3, 13]] as [number, number][],
      pnlHistory: [[0, 0], [2, 2], [3, 3]] as [number, number][],
    };
    expect(windowPoints(w, 0, 2)).toEqual([{ ts: 0, accountValue: 10, pnl: 0 }, { ts: 2, accountValue: 12, pnl: 2 }]);
  });
});

describe("stats", () => {
  test("ranks average ties", () => expect(ranks([10, 20, 20, 5])).toEqual([2, 3.5, 3.5, 1]));

  test("spearman is ±1 for monotone relations", () => {
    expect(spearman([1, 2, 3, 4], [1, 8, 27, 64])).toBeCloseTo(1);
    expect(spearman([1, 2, 3, 4], [4, 3, 2, 1])).toBeCloseTo(-1);
  });

  test("mann–whitney: separated groups give AUC 1 and a small p; identical give AUC 0.5", () => {
    const hi = mannWhitney([10, 11, 12, 13, 14, 15], [1, 2, 3, 4, 5, 6]);
    expect(hi.auc).toBe(1);
    expect(hi.z).toBeGreaterThan(2.5);
    expect(hi.p).toBeLessThan(0.01);
    const same = mannWhitney([1, 1, 1], [1, 1, 1]);
    expect(same.auc).toBe(0.5);
    expect(same.p).toBeCloseTo(1, 6);
  });

  test("permutation test finds a strong relation and not a null one", () => {
    const random = rng(1);
    const x = Array.from({ length: 60 }, (_, i) => i);
    expect(spearmanPermutation(x, x.map((v) => v + 5 * random()), 500, random).p).toBeLessThan(0.01);
    expect(spearmanPermutation(x, x.map(() => random()), 500, random).p).toBeGreaterThan(0.01);
  });

  test("bootstrap CI brackets the sample statistic", () => {
    const random = rng(2);
    const xs = Array.from({ length: 200 }, () => random());
    const [lo, hi] = bootstrap(xs.length, (idx) => idx.reduce((s, i) => s + xs[i], 0) / idx.length, 1000, random);
    expect(lo).toBeLessThan(0.5);
    expect(hi).toBeGreaterThan(0.5);
    expect(hi - lo).toBeLessThan(0.2);
  });

  test("ols recovers known coefficients", () => {
    const a = [1, 2, 3, 4, 5, 6];
    const b = [2, 1, 4, 3, 6, 5];
    const y = a.map((v, i) => 1 + 2 * v - 3 * b[i]);
    const beta = ols([a, b], y);
    expect(beta[0]).toBeCloseTo(1);
    expect(beta[1]).toBeCloseTo(2);
    expect(beta[2]).toBeCloseTo(-3);
  });
});

import { describe, expect, test } from "bun:test";
import { marginScale, planFlatten, planOrders, type LiveAccount, type Market, type PlanConfig } from "../src/planner";

const markets = new Map<string, Market>([
  ["BTC", { name: "BTC", assetId: 0, szDecimals: 5, maxLeverage: 40, markPx: 100_000 }],
  ["ETH", { name: "ETH", assetId: 1, szDecimals: 4, maxLeverage: 25, markPx: 4_000 }],
  ["xyz:MSFT", { name: "xyz:MSFT", assetId: 110_005, szDecimals: 3, maxLeverage: 10, markPx: 500 }],
]);

const cfg: PlanConfig = { minOrderUsd: 10, driftFraction: 0.1, marginCap: 0.95, slippageBps: 50 };

const account = (equityUsd: number, positions: Record<string, number> = {}): LiveAccount => ({
  equityUsd,
  positions: new Map(Object.entries(positions).map(([asset, szi]) => [asset, { szi }])),
});

const targets = (t: Record<string, number>) => new Map(Object.entries(t));

describe("planOrders", () => {
  test("opens new positions with IOC limits at mark ± slippage", () => {
    const plan = planOrders(targets({ BTC: 200, ETH: -100 }), account(470), markets, cfg);
    expect(plan.orders).toEqual([
      expect.objectContaining({ asset: "BTC", assetId: 0, isBuy: true, size: "0.002", price: "100500", reduceOnly: false }),
      expect.objectContaining({ asset: "ETH", assetId: 1, isBuy: false, size: "0.025", price: "3980", reduceOnly: false }),
    ]);
    expect(plan.skipped).toEqual([]);
    expect(plan.marginScale).toBe(1);
  });

  test("uses HIP-3 asset ids", () => {
    const plan = planOrders(targets({ "xyz:MSFT": 50 }), account(470), markets, cfg);
    expect(plan.orders[0]).toMatchObject({ assetId: 110_005, size: "0.1" });
  });

  test("skips legs within 10% of target (drift rule)", () => {
    // Holding 0.0019 BTC = $190 against a $200 target: gap $10 = 5%.
    const plan = planOrders(targets({ BTC: 200 }), account(470, { BTC: 0.0019 }), markets, cfg);
    expect(plan.orders).toEqual([]);
    expect(plan.skipped).toEqual([expect.objectContaining({ asset: "BTC", reason: "BELOW_DRIFT" })]);
  });

  test("skips gaps under the $10 minimum order", () => {
    const plan = planOrders(targets({ ETH: 8 }), account(470), markets, cfg);
    expect(plan.skipped).toEqual([expect.objectContaining({ asset: "ETH", reason: "BELOW_MIN_ORDER" })]);
  });

  test("skips orders whose rounded size falls under $10", () => {
    // $10.5 of BTC rounds down to 0.0001 BTC = $10 → ok; $10.5 of a coarse-lot market may not.
    const coarse = new Map(markets).set("BTC", { ...markets.get("BTC")!, szDecimals: 3 });
    const plan = planOrders(targets({ BTC: 150 }), account(470), coarse, cfg);
    expect(plan.orders[0]).toMatchObject({ size: "0.001" });
    const tooSmall = planOrders(targets({ BTC: 50 }), account(470), coarse, cfg);
    expect(tooSmall.skipped).toEqual([expect.objectContaining({ reason: "SIZE_ROUNDS_TO_ZERO" })]);
  });

  test("closes held positions missing from the targets, reduce-only, even under $10", () => {
    const plan = planOrders(targets({}), account(470, { ETH: 0.001 }), markets, cfg);
    expect(plan.orders).toEqual([expect.objectContaining({ asset: "ETH", isBuy: false, size: "0.001", reduceOnly: true })]);
  });

  test("marks partial reductions reduce-only but not flips", () => {
    const reduce = planOrders(targets({ BTC: 100 }), account(470, { BTC: 0.003 }), markets, cfg);
    expect(reduce.orders[0]).toMatchObject({ isBuy: false, size: "0.002", reduceOnly: true });
    const flip = planOrders(targets({ BTC: -100 }), account(470, { BTC: 0.003 }), markets, cfg);
    expect(flip.orders[0]).toMatchObject({ isBuy: false, size: "0.004", reduceOnly: false });
  });

  test("puts reductions before new risk", () => {
    const plan = planOrders(targets({ ETH: 200 }), account(470, { BTC: 0.003 }), markets, cfg);
    expect(plan.orders.map((o) => [o.asset, o.reduceOnly])).toEqual([
      ["BTC", true],
      ["ETH", false],
    ]);
  });

  test("reports assets without market data", () => {
    const plan = planOrders(targets({ DOGE: 50 }), account(470), markets, cfg);
    expect(plan.skipped).toEqual([expect.objectContaining({ asset: "DOGE", reason: "UNKNOWN_MARKET" })]);
  });
});

describe("marginScale (95% rule)", () => {
  test("leaves targets alone under the cap", () => {
    // $4,000 BTC at 40× = $100 margin < 0.95 × $470.
    expect(marginScale(targets({ BTC: 4_000 }), markets, 470, 0.95)).toEqual({ scale: 1, initialMarginUsd: 100 });
  });

  test("scales all targets pro-rata to the cap", () => {
    // $10,000 MSFT at 10× = $1,000 margin; cap 0.95 × $470 = $446.5.
    const { scale, initialMarginUsd } = marginScale(targets({ "xyz:MSFT": 10_000 }), markets, 470, 0.95);
    expect(scale).toBeCloseTo(0.4465, 6);
    expect(initialMarginUsd).toBeCloseTo(446.5, 6);
  });

  test("applies the scale to planned sizes", () => {
    const plan = planOrders(targets({ "xyz:MSFT": 10_000, BTC: 10_000 }), account(470), markets, cfg);
    // Margin: 1000 + 250 = 1250 → scale 446.5 / 1250.
    expect(plan.marginScale).toBeCloseTo(0.3572, 4);
    expect(plan.orders.find((o) => o.asset === "BTC")?.size).toBe("0.03572");
  });

  test("zero equity scales everything to zero", () => {
    expect(marginScale(targets({ BTC: 100 }), markets, 0, 0.95).scale).toBe(0);
  });
});

describe("planFlatten", () => {
  test("closes every position reduce-only", () => {
    const plan = planFlatten(account(470, { BTC: 0.002, ETH: -0.05, "xyz:MSFT": 0.3 }), markets, 50);
    expect(plan.orders.map((o) => [o.asset, o.isBuy, o.size, o.reduceOnly])).toEqual([
      ["BTC", false, "0.002", true],
      ["ETH", true, "0.05", true],
      ["xyz:MSFT", false, "0.3", true],
    ]);
  });
});

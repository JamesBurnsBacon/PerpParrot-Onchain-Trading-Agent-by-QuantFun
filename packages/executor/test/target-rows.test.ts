import { describe, expect, test } from "bun:test";
import type { Market, Plan } from "../src/planner";
import type { RunRecord } from "../src/store";
import { targetRows, type TargetRowsInput } from "../src/target-rows";

const market = (name: string, markPx: number, tradable = true): Market => ({ name, assetId: 0, szDecimals: 4, maxLeverage: 10, markPx, tradable });
const markets = new Map([market("BTC", 100_000), market("ETH", 4_000), market("SOL", 200), market("xyz:CL", 70, false), market("HYPE", 40)].map((m) => [m.name, m]));
const record: RunRecord = { id: "mirror-1", runId: "mirror-1", kind: "mirror", status: "executed", dryRun: true, startedAt: 1, finishedAt: 2 };

const input = (plan: Plan, results: RunRecord["results"], overrides: Partial<TargetRowsInput> = {}): TargetRowsInput => ({
  record: { ...record, plan, results },
  runAt: 1_000,
  plan,
  markets,
  // Held: ETH −0.05 (−$200), SOL 1 ($200), xyz:CL 10 ($700), HYPE 5 ($200).
  account: { equityUsd: 400, positions: new Map([["ETH", { szi: -0.05 }], ["SOL", { szi: 1 }], ["xyz:CL", { szi: 10 }], ["HYPE", { szi: 5 }]]) },
  sizingEquityUsd: 400,
  exposures: new Map([["BTC", 3], ["ETH", -0.875], ["SOL", 0.52], ["xyz:CL", 2], ["HYPE", 0.5]]),
  configurationHash: "0xconf",
  snapshotHash: "0xsnap",
  cloidFor: (asset) => `cloid-${asset}`,
  ...overrides,
});

const plan: Plan = {
  marginScale: 1,
  initialMarginUsd: 0,
  orders: [
    { asset: "BTC", assetId: 0, isBuy: true, price: "100500", size: "0.012", reduceOnly: false, notionalUsd: 1200, targetUsd: 1200, currentUsd: 0 },
    { asset: "ETH", assetId: 1, isBuy: false, price: "3980", size: "0.0375", reduceOnly: false, notionalUsd: -150, targetUsd: -350, currentUsd: -200 },
  ],
  skipped: [
    { asset: "SOL", reason: "BELOW_DRIFT", targetUsd: 208, currentUsd: 200 },
    { asset: "xyz:CL", reason: "NOT_TRADABLE", targetUsd: 800, currentUsd: 700 },
  ],
};

describe("targetRows", () => {
  test("one row per perp: orders with results, skipped gaps, and perps with no gap", () => {
    const rows = targetRows(input(plan, [{ asset: "BTC", status: "filled", filledSize: "0.012", avgPx: "100010" }, { asset: "ETH", status: "error", error: "margin" }]));
    expect(rows.map((r) => [r.asset, r.action, r.skipReason, r.resultStatus])).toEqual([
      ["BTC", "order", null, "filled"],
      ["ETH", "order", null, "error"],
      // Held $200, target 0.5 × 400 = $200: no gap, so no planner entry.
      ["HYPE", "none", null, null],
      ["SOL", "skipped", "BELOW_DRIFT", null],
      // Capped to what we hold (not tradable): no gap left, so only the cap is noted.
      ["xyz:CL", "skipped", "NOT_TRADABLE", null],
    ]);
    const [btc, eth, hype, sol, cl] = rows;
    expect(btc).toMatchObject({
      runId: "mirror-1", runAt: 1_000, kind: "mirror", dryRun: true, runStatus: "executed", configurationHash: "0xconf", snapshotHash: "0xsnap",
      sizingEquityUsd: 400, targetExposure: 3, marginScale: 1, targetUsd: 1200, heldSize: 0, markPx: 100_000, heldUsd: 0, gapUsd: 1200,
      side: "buy", size: "0.012", price: "100500", reduceOnly: false, notionalUsd: 1200, cloid: "cloid-BTC", filledSize: "0.012", avgPx: "100010", resultError: null,
    });
    expect(eth).toMatchObject({ targetUsd: -350, heldUsd: -200, gapUsd: -150, side: "sell", resultError: "margin", filledSize: null });
    expect(hype).toMatchObject({ targetExposure: 0.5, targetUsd: 200, heldUsd: 200, gapUsd: 0, side: null, cloid: null });
    expect(sol).toMatchObject({ targetUsd: 208, heldUsd: 200, gapUsd: 8 });
    expect(cl).toMatchObject({ targetExposure: 2, targetUsd: 700, heldUsd: 700, gapUsd: 0 });
  });

  test("a held perp the targets dropped is a full close; a capped order keeps its NOT_TRADABLE note", () => {
    const close: Plan = {
      marginScale: 0.5,
      initialMarginUsd: 0,
      orders: [{ asset: "xyz:CL", assetId: 110_000, isBuy: false, price: "69.65", size: "2", reduceOnly: true, notionalUsd: -140, targetUsd: 560, currentUsd: 700 }],
      skipped: [{ asset: "xyz:CL", reason: "NOT_TRADABLE", targetUsd: 1400, currentUsd: 700 }],
    };
    const rows = targetRows(input(close, [{ asset: "xyz:CL", status: "dry_run" }], { exposures: new Map([["xyz:CL", 3.5]]), account: { equityUsd: 400, positions: new Map([["xyz:CL", { szi: 10 }], ["ETH", { szi: -0.05 }]]) } }));
    expect(rows.map((r) => [r.asset, r.action, r.skipReason, r.targetExposure, r.marginScale])).toEqual([
      ["ETH", "none", null, 0, 0.5],
      ["xyz:CL", "order", "NOT_TRADABLE", 3.5, 0.5],
    ]);
    expect(rows[1]).toMatchObject({ targetUsd: 560, gapUsd: -140, reduceOnly: true, resultStatus: "dry_run" });
  });

  test("orders of a run that stopped before submitting are not sent; unknown markets have no price", () => {
    const stopped: Plan = { ...plan, skipped: [{ asset: "DELISTED", reason: "UNKNOWN_MARKET", targetUsd: 50, currentUsd: 0 }] };
    const rows = targetRows(input(stopped, undefined, { exposures: new Map([["BTC", 3], ["ETH", -0.875], ["DELISTED", 0.125]]), account: { equityUsd: 400, positions: new Map([["ETH", { szi: -0.05 }]]) } }));
    expect(rows.map((r) => [r.asset, r.action, r.resultStatus])).toEqual([
      ["BTC", "order", "not_sent"],
      ["DELISTED", "skipped", null],
      ["ETH", "order", "not_sent"],
    ]);
    expect(rows[1]).toMatchObject({ markPx: null, heldUsd: 0, skipReason: "UNKNOWN_MARKET" });
  });
});

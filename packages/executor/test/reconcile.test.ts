import { describe, expect, test } from "bun:test";
import type { Hex } from "viem";
import type { InfoFn } from "../src/hyperliquid";
import { reconcileBatches } from "../src/reconcile";
import { MemoryStore } from "../src/store";

const T0 = 1_791_264_000_000;
const cloid = (n: number) => `0x${String(n).padStart(2, "0").repeat(16)}` as Hex;
const order = (asset: string) => ({ asset, assetId: 0, isBuy: true, price: "1", size: "1", reduceOnly: false, notionalUsd: 1, targetUsd: 1, currentUsd: 0 });

const run = async (info: InfoFn, nowMs: number, seed: (store: MemoryStore) => Promise<void>) => {
  const store = new MemoryStore();
  await seed(store);
  const outcome = await reconcileBatches({ store, info, account: "0xabc", now: () => nowMs, runTtlSeconds: 300 }, await store.unresolvedOrderBatches());
  return { store, outcome };
};

describe("reconcileBatches", () => {
  test("past its signed expiry: closed even when Hyperliquid can't be read, with the failure as evidence", async () => {
    const down = (async () => { throw new Error("HL info 502"); }) as InfoFn;
    const { store, outcome } = await run(down, T0 + 306_000, (s) => s.beginOrderBatch({ id: "a:0", runId: "a", createdAt: T0, orders: [order("BTC")], cloids: [cloid(1)], kind: "orders" }));
    expect(outcome.inFlight.size).toBe(0);
    expect(outcome.resolved).toEqual([{ id: "a:0", evidence: `past its signed expiry, so it can no longer land; BTC ${cloid(1)}: lookup failed (HL info 502)` }]);
    expect(await store.unresolvedOrderBatches()).toEqual([]);
  });

  test("before expiry: open only while some order isn't final; partial fills are reported", async () => {
    const info = (async (req: Record<string, unknown>) =>
      req.oid === cloid(1)
        ? { status: "order", order: { order: { origSz: "2", sz: "0.5" }, status: "canceled" } }
        : { status: "order", order: { order: { origSz: "1", sz: "1" }, status: "open" } }) as InfoFn;
    const { store, outcome } = await run(info, T0 + 60_000, async (s) => {
      await s.beginOrderBatch({ id: "final:0", runId: "final", createdAt: T0, orders: [order("BTC")], cloids: [cloid(1)], kind: "orders" });
      await s.finishOrderBatch("final:0", [{ asset: "BTC", status: "unknown" }]);
      await s.beginOrderBatch({ id: "open:0", runId: "open", createdAt: T0, orders: [order("xyz:CL"), order("ETH")], cloids: [cloid(2), cloid(3)], kind: "orders" });
    });
    expect(outcome.resolved.map((r) => r.evidence)).toEqual([`every order final on Hyperliquid; BTC ${cloid(1)}: canceled, filled 1.5 of 2`]);
    expect([...outcome.inFlight].sort()).toEqual(["ETH", "xyz:CL"]);
    expect((await store.unresolvedOrderBatches()).map((b) => b.id)).toEqual(["open:0"]);
  });

  test("leverage: closed when Hyperliquid shows the cross leverage we asked for, or once expired", async () => {
    const info = (async (req: Record<string, unknown>) => ({ leverage: { type: "cross", value: req.coin === "BTC" ? 40 : 3 } })) as InfoFn;
    const seed = async (s: MemoryStore) => {
      await s.beginOrderBatch({ id: "r:leverage:0", runId: "r", createdAt: T0, orders: [], cloids: [], kind: "leverage", details: { asset: "BTC", assetId: 0, leverage: 40 } });
      await s.beginOrderBatch({ id: "r:leverage:1", runId: "r", createdAt: T0, orders: [], cloids: [], kind: "leverage", details: { asset: "ETH", assetId: 1, leverage: 25 } });
    };
    const early = await run(info, T0 + 60_000, seed);
    expect(early.outcome.leverageAssetIds).toEqual([0]);
    expect([...early.outcome.inFlight]).toEqual(["ETH"]);
    const late = await run(info, T0 + 400_000, seed);
    expect(late.outcome.leverageAssetIds).toEqual([0, 1]);
    expect(late.outcome.resolved[1].evidence).toBe("past its signed expiry, so it can no longer land; ETH leverage cross 3x (wanted cross 25x)");
  });
});

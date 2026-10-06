import { describe, expect, test } from "bun:test";
import type { IRequestTransport } from "@nktkas/hyperliquid";
import type { Hex } from "viem";
import { createExchange, ORDER_BATCH_SIZE } from "../src/exchange";
import type { PlannedOrder } from "../src/planner";

const KEY = `0x${"22".repeat(32)}` as Hex;

const planned = (asset: string, assetId: number): PlannedOrder => ({
  asset,
  assetId,
  isBuy: true,
  price: "100",
  size: "1",
  reduceOnly: false,
  notionalUsd: 100,
  targetUsd: 100,
  currentUsd: 0,
});

// A stand-in for HL's /exchange that answers each order batch with the given statuses.
const fakeHl = (answer: (orders: unknown[]) => unknown) => {
  const requests: unknown[] = [];
  const transport: IRequestTransport = {
    isTestnet: false,
    async request<T>(_endpoint: string, payload: unknown) {
      requests.push(payload);
      const orders = (payload as { action: { orders: unknown[] } }).action.orders;
      return answer(orders) as T;
    },
  };
  return { transport, requests };
};

const cloids = (n: number) => Array.from({ length: n }, (_, i) => `0x${i.toString(16).padStart(32, "0")}` as Hex);

describe("live submission", () => {
  test("maps filled, resting and error statuses per order", async () => {
    const { transport } = fakeHl(() => ({
      status: "ok",
      response: {
        type: "order",
        data: { statuses: [{ filled: { totalSz: "1", avgPx: "100.1", oid: 1 } }, { resting: { oid: 2 } }] },
      },
    }));
    const ex = createExchange({ privateKey: KEY, dryRun: false, transport });
    expect(await ex.submit([planned("BTC", 0), planned("ETH", 1)], cloids(2))).toEqual([
      { asset: "BTC", status: "filled", filledSize: "1", avgPx: "100.1" },
      { asset: "ETH", status: "resting" },
    ]);
  });

  test("keeps fills when some orders in the batch error", async () => {
    // The SDK throws on any per-order error; the fills must not be reported as failures.
    const { transport } = fakeHl(() => ({
      status: "ok",
      response: {
        type: "order",
        data: { statuses: [{ filled: { totalSz: "1", avgPx: "100", oid: 1 } }, { error: "Order must have minimum value of $10." }] },
      },
    }));
    const ex = createExchange({ privateKey: KEY, dryRun: false, transport });
    expect(await ex.submit([planned("BTC", 0), planned("ETH", 1)], cloids(2))).toEqual([
      { asset: "BTC", status: "filled", filledSize: "1", avgPx: "100" },
      { asset: "ETH", status: "error", error: "Order must have minimum value of $10." },
    ]);
  });

  test("reports a whole-request error on every order", async () => {
    const { transport } = fakeHl(() => ({ status: "err", response: "User or API Wallet does not exist." }));
    const ex = createExchange({ privateKey: KEY, dryRun: false, transport });
    const results = await ex.submit([planned("BTC", 0)], cloids(1));
    expect(results).toEqual([{ asset: "BTC", status: "error", error: "User or API Wallet does not exist." }]);
  });

  test("malformed order result is uncertain and stops later batches", async () => {
    const requests: unknown[] = [];
    const transport: IRequestTransport = {
      isTestnet: false,
      async request<T>(_endpoint: string, payload: unknown) {
        requests.push(payload);
        return { status: "ok", response: { type: "order", data: { statuses: [{ unexpected: true }] } } } as T;
      },
    };
    const ex = createExchange({ privateKey: KEY, dryRun: false, transport });
    const results = await ex.submit(Array.from({ length: 21 }, (_, i) => planned(`A${i}`, i)), cloids(21));
    expect(requests).toHaveLength(1);
    expect(results[0].status).toBe("unknown");
    expect(results.filter((r) => r.status === "not_sent")).toHaveLength(1);
  });

  test("rejects incomplete client order ID lists before submission", async () => {
    const { transport, requests } = fakeHl(() => ({ status: "ok", response: {} }));
    const ex = createExchange({ privateKey: KEY, dryRun: false, transport });
    await expect(ex.submit([planned("BTC", 0)], [])).rejects.toThrow("one client order ID");
    expect(requests).toHaveLength(0);
  });

  test("lost response records uncertainty and prevents later batches", async () => {
    const requests: unknown[] = [];
    const transport: IRequestTransport = {
      isTestnet: false,
      async request<T>(_endpoint: string, payload: unknown): Promise<T> {
        requests.push(payload);
        throw new Error("response lost after dispatch");
      },
    };
    const ex = createExchange({ privateKey: KEY, dryRun: false, transport });
    const orders = Array.from({ length: 45 }, (_, i) => planned(`A${i}`, i));
    const results = await ex.submit(orders, cloids(45));
    expect(requests).toHaveLength(1);
    expect(results.filter((r) => r.status === "unknown")).toHaveLength(20);
    expect(results.filter((r) => r.status === "not_sent")).toHaveLength(25);
  });

  test(`splits into batches of ${ORDER_BATCH_SIZE}`, async () => {
    const { transport, requests } = fakeHl((orders) => ({
      status: "ok",
      response: { type: "order", data: { statuses: orders.map(() => ({ resting: { oid: 1 } })) } },
    }));
    const ex = createExchange({ privateKey: KEY, dryRun: false, transport });
    const orders = Array.from({ length: 45 }, (_, i) => planned(`A${i}`, i));
    const results = await ex.submit(orders, cloids(45));
    expect(requests.map((r) => (r as { action: { orders: unknown[] } }).action.orders.length)).toEqual([20, 20, 5]);
    expect(results).toHaveLength(45);
    // Batches keep each order's own cloid.
    const third = (requests[2] as { action: { orders: { c: string }[] } }).action.orders[0];
    expect(third.c).toBe(cloids(45)[40]);
  });
});

describe("stopping between batches", () => {
  test.each([false, true])("sends no further batches with asynchronous guard=%s", async (asynchronous) => {
    const { transport, requests } = fakeHl((orders) => ({
      status: "ok",
      response: { type: "order", data: { statuses: orders.map(() => ({ resting: { oid: 1 } })) } },
    }));
    const ex = createExchange({ privateKey: KEY, dryRun: false, transport });
    const orders = Array.from({ length: 45 }, (_, i) => planned(`A${i}`, i));
    const results = await ex.submit(orders, cloids(45), () => asynchronous ? Promise.resolve(requests.length >= 1) : requests.length >= 1);
    expect(requests).toHaveLength(1);
    expect(results.filter((r) => r.status === "not_sent")).toHaveLength(25);
  });
});

describe("journal failures keep what the exchange already did", () => {
  const resting = () => fakeHl((orders) => ({
    status: "ok",
    response: { type: "order", data: { statuses: orders.map(() => ({ resting: { oid: 1 } })) } },
  }));
  test("a failed write before batch 2 keeps batch 1's results and sends nothing more", async () => {
    const { transport, requests } = resting();
    const ex = createExchange({ privateKey: KEY, dryRun: false, transport });
    const orders = Array.from({ length: 45 }, (_, i) => planned(`A${i}`, i));
    const results = await ex.submit(orders, cloids(45), undefined, undefined, {
      beforeDispatch: async (batch) => { if (batch === 1) throw new Error("database query timed out"); },
      afterResponse: async () => undefined,
    });
    expect(requests).toHaveLength(1);
    expect(results.slice(0, 20).every((r) => r.status === "resting")).toBe(true);
    expect(results.slice(20).every((r) => r.status === "not_sent" && r.error?.startsWith("journal write failed before dispatch"))).toBe(true);
  });
  test("a failed write after a response keeps that batch's results and stops", async () => {
    const { transport, requests } = resting();
    const ex = createExchange({ privateKey: KEY, dryRun: false, transport });
    const orders = Array.from({ length: 45 }, (_, i) => planned(`A${i}`, i));
    const results = await ex.submit(orders, cloids(45), undefined, undefined, {
      beforeDispatch: async () => undefined,
      afterResponse: async (batch) => { if (batch === 0) throw new Error("database query timed out"); },
    });
    expect(requests).toHaveLength(1);
    expect(results.slice(0, 20).every((r) => r.status === "resting")).toBe(true);
    expect(results.slice(20).every((r) => r.status === "not_sent" && r.error?.includes("batch 0 needs reconciliation"))).toBe(true);
  });
});

describe("dry run", () => {
  test("signs but never uses a live transport", async () => {
    let called = false;
    const transport: IRequestTransport = {
      isTestnet: false,
      async request<T>() {
        called = true;
        return {} as T;
      },
    };
    const ex = createExchange({ dryRun: true, transport });
    expect(await ex.submit([planned("BTC", 0)], cloids(1))).toEqual([{ asset: "BTC", status: "dry_run" }]);
    expect(called).toBe(false);
    expect(ex.recorded()).toHaveLength(1);
  });

  test("requires a key to go live", () => {
    expect(() => createExchange({ dryRun: false })).toThrow("HL_API_WALLET_KEY is required");
  });
});

import { beforeEach, describe, expect, test } from "bun:test";
import { MemoryRequestStore } from "../src/chat/handler";
import { MemoryChatLimiter } from "../src/chat/limits";
import { readLiveEnv } from "../src/live/config";
import { handleLivePlan, handleLiveRequest, resetPlanCache, type LiveRequestDeps } from "../src/live/request";
import { buildDryRunPlan, sketchOrders, type PlanMarket } from "../src/live/plan";
import { buildPreview } from "../src/chat/preview";
import { isDryRunPlan } from "../../shared/dry-run-plan";
import type { HlReader } from "../src/hyperliquid";
import type { Policy } from "../../shared/src/contracts";
import fixture from "../fixtures/frozen-configuration.json";

const args = { riskStyle: "aggressive", maxSources: 10, diversification: "low", leverageComfort: "high", requestedLeverage: null, avoidClones: true, horizon: "medium" };
const addr = (i: number) => `0x${i.toString(16).padStart(40, "0")}`;
const MARKETS = new Map<string, PlanMarket>([
  ["BTC", { markPx: 100_000, szDecimals: 5, maxLeverage: 40, tradable: true }],
  ["ETH", { markPx: 4_000, szDecimals: 4, maxLeverage: 25, tradable: true }],
  ["DOGE", { markPx: 0.2, szDecimals: 0, maxLeverage: 10, tradable: false }],
]);
// Each source: a $1M account holding $500k of BTC long and $200k of ETH short.
const hl: HlReader = {
  perp: async (_u, dex) => dex === "xyz" ? { assetPositions: [] } : { assetPositions: [
    { position: { coin: "BTC", szi: "5", positionValue: "500000" } }, { position: { coin: "ETH", szi: "-50", positionValue: "200000" } }] },
  portfolio: async () => [["day", { accountValueHistory: [[1, "900000"], [2, "1000000"]] }]],
};
const NOW = 2_000_000_000_000;
const deps = (): LiveRequestDeps & { store: MemoryRequestStore; calls: { n: number } } => {
  const store = new MemoryRequestStore(), calls = { n: 0 };
  return { store, calls, requests: store, newId: () => `req-${store.requests.size + 1}`,
    env: readLiveEnv({ LIVE_ENABLED: "true", OPENAI_API_KEY: "k" }),
    chatEnv: { ipSalt: "salt", limits: { ipHourly: 10, previewIpHourly: 30, previewGlobalDaily: 500, globalDaily: 100, dailyBudgetMicroUsd: 5_000_000 } },
    limiter: new MemoryChatLimiter(), now: () => NOW, log: () => {}, basePolicy: fixture.policy as Policy,
    finalists: async () => ({ dataSource: "sample", finalists: Array.from({ length: 25 }, (_, i) => ({ address: addr(i + 1), kind: "trader" as const, score: 100 - i, flags: [], maxDrawdown: 0.1, realizedVol: 0.5, cloneOf: false })) } as never),
    fetchImpl: fetch,
    planDeps: { now: () => NOW, hl: { perp: async (u, d) => { calls.n++; return hl.perp(u, d); }, portfolio: hl.portfolio }, markets: async () => MARKETS } };
};
const post = (path: string, body: unknown, ip = "a") => new Request(`http://localhost${path}`, { method: "POST", headers: { "content-type": "application/json", "x-forwarded-for": ip }, body: JSON.stringify(body) });

describe("sketchOrders (pure)", () => {
  const cases = (t: Record<string, number>) => new Map(Object.entries(t));
  test("a flat account gets buy and sell orders sized to the lot, with the gross they add up to", () => {
    const plan = sketchOrders(cases({ BTC: 100, ETH: -50 }), MARKETS, 470, NOW);
    expect(plan.orders).toEqual([
      { asset: "BTC", isBuy: true, size: "0.00100", notionalUsd: 100, markPx: 100_000 },
      { asset: "ETH", isBuy: false, size: "0.0125", notionalUsd: -50, markPx: 4_000 },
    ]);
    expect(plan.grossUsd).toBe(150);
    expect(plan.marginScale).toBe(1);
    expect(isDryRunPlan(plan)).toBe(true);
  });
  test("skips unknown and untradable markets and legs under the minimum order, and never invents an order", () => {
    const plan = sketchOrders(cases({ BTC: 100, NOPE: 100, DOGE: 100, ETH: 5 }), MARKETS, 470, NOW);
    expect(plan.orders.map(o => o.asset)).toEqual(["BTC"]);
    expect(Object.fromEntries(plan.skipped.map(s => [s.asset, s.reason]))).toEqual({ NOPE: "UNKNOWN_MARKET", DOGE: "NOT_TRADABLE", ETH: "BELOW_MIN_ORDER" });
  });
  test("the margin rule scales every target down pro rata when initial margin would pass 95% of equity", () => {
    const plan = sketchOrders(cases({ BTC: 20_000, ETH: -10_000 }), MARKETS, 470, NOW);
    expect(plan.marginScale).toBeLessThan(1);
    const margin = plan.orders.reduce((s, o) => s + Math.abs(o.notionalUsd) / MARKETS.get(o.asset)!.maxLeverage, 0);
    expect(margin).toBeLessThanOrEqual(0.95 * 470 + 0.01);
  });
});

test("buildDryRunPlan turns a shortlist's real-shaped positions into a plan without any write", async () => {
  const d = deps();
  const preview = buildPreview({ intent: { ...args, clarify: null, reply: "x" } as never, basePolicy: d.basePolicy, addresses: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map(addr) });
  const plan = await buildDryRunPlan(preview, d.planDeps);
  expect(isDryRunPlan(plan)).toBe(true);
  expect(plan.orders.some(o => o.asset === "BTC" && o.isBuy)).toBe(true);
  expect(plan.orders.some(o => o.asset === "ETH" && !o.isBuy)).toBe(true);
  expect(plan.equityUsd).toBe(470);
  expect(d.store.requests.size).toBe(0);
});

describe("/live/plan and /live/request", () => {
  beforeEach(resetPlanCache);
  test("plan saves nothing, is capped by the rate limiter, and a repeat within a minute reuses the reads", async () => {
    const d = deps();
    const first = await (await handleLivePlan(post("/live/plan", { intent: args }), d)).json() as { ok: boolean; previewHash: string; plan: unknown };
    expect(first.ok).toBe(true);
    expect(isDryRunPlan(first.plan)).toBe(true);
    expect(d.store.requests.size).toBe(0);
    const reads = d.calls.n;
    expect(reads).toBeGreaterThan(0);
    await handleLivePlan(post("/live/plan", { intent: args }), d);
    expect(d.calls.n).toBe(reads); // cached
  });
  test("request saves exactly one PENDING simulation request for the hash the visitor was shown", async () => {
    const d = deps();
    const { previewHash } = await (await handleLivePlan(post("/live/plan", { intent: args }), d)).json() as { previewHash: string };
    const res = await handleLiveRequest(post("/live/request", { intent: args, previewHash }), d);
    const body = await res.json() as { ok: boolean; requestId: string; preview: { approvalRequired: boolean; previewHash: string; policy: { mode: string } } };
    expect(res.status).toBe(200);
    expect(body).toMatchObject({ ok: true, requestId: "req-1", preview: { approvalRequired: true, previewHash, policy: { mode: "SIMULATION" } } });
    expect(d.store.requests.size).toBe(1);
    expect([...d.store.requests.values()][0].status).toBe("pending");
  });
  test("the intent exactly as /live/strategy returns it (with reply and clarify) is accepted, and gives the same hash as without them", async () => {
    const d = deps();
    const full = { ...args, reply: "Strategy checked by code. No orders are placed.", clarify: null };
    const a = await (await handleLivePlan(post("/live/plan", { intent: full }), d)).json() as { ok: boolean; previewHash: string };
    resetPlanCache();
    const b = await (await handleLivePlan(post("/live/plan", { intent: args }), d)).json() as { ok: boolean; previewHash: string };
    expect(a.ok).toBe(true);
    expect(a.previewHash).toBe(b.previewHash);
    const saved = await handleLiveRequest(post("/live/request", { intent: { ...full, reply: "anything the model said" }, previewHash: a.previewHash }), d);
    expect(saved.status).toBe(200);
    expect(d.store.requests.size).toBe(1);
  });
  test("a changed selection is refused with 409 and nothing is saved (positive control: the right hash saves)", async () => {
    const d = deps();
    const stale = `0x${"ab".repeat(32)}`;
    const res = await handleLiveRequest(post("/live/request", { intent: args, previewHash: stale }), d);
    expect(res.status).toBe(409);
    expect((await res.json() as { code: string }).code).toBe("changed");
    expect(d.store.requests.size).toBe(0);
  });
  test("bad shapes, off-schema intents and a disabled Live are rejected before any work", async () => {
    const d = deps();
    for (const body of [{}, { intent: args }, { intent: args, previewHash: "nope" }, { intent: { ...args, evil: 1 }, previewHash: `0x${"0".repeat(64)}` }, { intent: args, previewHash: `0x${"0".repeat(64)}`, extra: 1 }])
      expect((await handleLiveRequest(post("/live/request", body), d)).status).toBe(400);
    for (const body of [{}, { intent: { ...args, evil: 1 } }, { intent: args, extra: 1 }]) expect((await handleLivePlan(post("/live/plan", body), d)).status).toBe(400);
    const off = deps(); off.env.enabled = false;
    expect((await handleLiveRequest(post("/live/request", { intent: args, previewHash: `0x${"0".repeat(64)}` }), off)).status).toBe(503);
    expect(d.store.requests.size + off.store.requests.size).toBe(0);
  });
  test("an unreadable Hyperliquid answer is a 503, never a made-up plan", async () => {
    const d = deps(); d.planDeps = { ...d.planDeps, markets: async () => { throw new Error("HL down"); } };
    expect((await handleLivePlan(post("/live/plan", { intent: args }), d)).status).toBe(503);
  });
});

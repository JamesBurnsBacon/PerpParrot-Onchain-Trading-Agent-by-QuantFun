import { describe, expect, test } from "bun:test";
import type { Hex } from "viem";
import { createApp, type AppDeps } from "../src/app";
import { loadConfig } from "../src/config";
import { createExchange } from "../src/exchange";
import type { InfoFn } from "../src/hyperliquid";
import { cloidFor, Runner } from "../src/runner";
import { MemoryStore, type RunRecord } from "../src/store";
import { cronWatchdog } from "../src/watchdog";
import { ACCOUNT, AS_OF, CONFIGURATION, targets } from "./helpers";
import type { Targets } from "../src/targets";

// Fake HL info: BTC/ETH on core, MSFT on xyz (dex index 1), and our account.
const fakeInfo = (account: { equity: string; core?: [string, string][]; xyz?: [string, string][] }): InfoFn =>
  (async (req: Record<string, unknown>) => {
    switch (req.type) {
      case "perpDexs":
        return [null, { name: "xyz" }];
      case "metaAndAssetCtxs":
        return req.dex === "xyz"
          ? [{ universe: [{ name: "xyz:MSFT", szDecimals: 3, maxLeverage: 10 }] }, [{ markPx: "500", openInterest: "1000000" }]]
          : [
              {
                universe: [
                  { name: "BTC", szDecimals: 5, maxLeverage: 40 },
                  { name: "ETH", szDecimals: 4, maxLeverage: 25 },
                  { name: "OLD", szDecimals: 0, maxLeverage: 3, isDelisted: true },
                ],
              },
              [{ markPx: "100000", openInterest: "1000" }, { markPx: "4000", openInterest: "100000" }, { markPx: "1", openInterest: "0" }],
            ];
      case "clearinghouseState": {
        const positions = (req.dex === "xyz" ? account.xyz : account.core) ?? [];
        return { assetPositions: positions.map(([coin, szi]) => ({ position: { coin, szi } })) };
      }
      case "portfolio":
        return [["day", { accountValueHistory: [[1, "1"], [2, account.equity]] }]];
    }
    throw new Error(`unexpected info request ${req.type}`);
  }) as InfoFn;

const setup = (info: InfoFn) => {
  const store = new MemoryStore();
  // The backend's answer per run; tests override a run's targets here.
  const overrides = new Map<number, Partial<Targets>>();
  const exchange = createExchange({ dryRun: true });
  const alerts: string[] = [];
  const runnerDeps = {
    store,
    exchange,
    info,
    alert: async (m: string) => void alerts.push(m),
    now: () => AS_OF * 1000,
    targets: async (runAt: number) => targets({ runAt, ...overrides.get(runAt) }),
    config: {
      account: ACCOUNT,
      frozenConfigurationHash: CONFIGURATION,
      maxGrossLeverage: 50,
      runTtlSeconds: 300,
      runTimeoutMs: 1_000,
      plan: { minOrderUsd: 10, driftFraction: 0.1, marginCap: 0.95, slippageBps: 50 },
    },
  };
  return { store, exchange, runner: new Runner(runnerDeps), runnerDeps, alerts, overrides };
};


describe("Runner: cross-process run lock", () => {
  test("a run that can't get the lock is recorded as failed and alerted", async () => {
    const { runnerDeps, store, alerts } = setup(fakeInfo({ equity: "400", core: [] }));
    const lock = { acquire: async () => Promise.reject(new Error("another executor process held the run lock for 1s")) };
    const record = await new Runner({ ...runnerDeps, lock }).executeRun(AS_OF);
    expect(record).toMatchObject({ status: "failed", error: "another executor process held the run lock for 1s" });
    expect((await store.recentRuns(1))[0].status).toBe("failed");
    expect(alerts.join()).toContain("held the run lock");
  });

  test("holds the lock for the whole run, saving included, then releases it", async () => {
    const { runnerDeps } = setup(fakeInfo({ equity: "400", core: [["ETH", "-0.05"]] }));
    const events: string[] = [];
    const store = runnerDeps.store;
    const tracked = Object.assign(Object.create(Object.getPrototypeOf(store)), store, {
      saveRun: async (r: RunRecord) => (events.push("save"), store.saveRun(r)),
    });
    const lock = {
      acquire: async (timeoutMs: number) => {
        events.push(`acquire ${timeoutMs}`);
        return async () => void events.push("release");
      },
    };
    const record = await new Runner({ ...runnerDeps, store: tracked, lock }).executeRun(AS_OF);
    expect(record.status).toBe("executed");
    expect(events).toEqual(["acquire 1000", "save", "release"]);
  });
});

describe("Runner.executeRun (dry run)", () => {
  test("plans against the live account and signs one IOC batch", async () => {
    const { runner, exchange, store } = setup(fakeInfo({ equity: "400", core: [["ETH", "-0.05"]] }));
    const run = await runner.executeRun(AS_OF);

    expect(run).toMatchObject({ status: "executed", dryRun: true, equityUsd: 400 });
    // BTC +$1200 from flat; ETH target −$350 vs −$200 held → sell $150 more.
    expect(run.plan?.orders.map((o) => [o.asset, o.isBuy, o.size])).toEqual([
      ["BTC", true, "0.012"],
      ["ETH", false, "0.0375"],
    ]);
    expect(run.results?.map((r) => r.status)).toEqual(["dry_run", "dry_run"]);

    // updateLeverage for BTC and ETH, then one order action.
    const sent = exchange.recorded();
    expect(sent.map((r) => (r.payload as { action: { type: string } }).action.type)).toEqual([
      "updateLeverage",
      "updateLeverage",
      "order",
    ]);
    const orderReq = sent[2].payload as {
      action: { orders: Record<string, unknown>[]; grouping: string };
      nonce: number;
      signature: { r: string; s: string; v: number };
    };
    expect(orderReq.action.grouping).toBe("na");
    expect(orderReq.action.orders[0]).toEqual({
      a: 0,
      b: true,
      p: "100500",
      s: "0.012",
      r: false,
      t: { limit: { tif: "Ioc" } },
      c: cloidFor(`mirror-${AS_OF}`, "BTC"),
    });
    expect(orderReq.signature.r).toMatch(/^0x[0-9a-f]{64}$/);
    expect(orderReq.nonce).toBeGreaterThan(0);
    expect(await store.recentRuns(1)).toEqual([run]);
    expect(await store.unresolvedOrderBatches()).toEqual([]);
  });

  test("expiry during leverage setup prevents the order batch", async () => {
    const { runnerDeps, exchange } = setup(fakeInfo({ equity: "400" }));
    let clock = AS_OF * 1000;
    runnerDeps.now = () => clock;
    const original = exchange.setLeverage;
    exchange.setLeverage = async (asset, leverage) => {
      const outcome = await original(asset, leverage);
      clock = (AS_OF + 301) * 1000;
      return outcome;
    };
    const run = await new Runner(runnerDeps).executeRun(AS_OF);
    expect(run.status).toBe("failed");
    expect(run.error).toContain("expired before exchange action");
    expect(exchange.recorded()).toHaveLength(1);
  });

  test("pause during leverage setup prevents further exchange actions", async () => {
    const { runnerDeps, exchange, store } = setup(fakeInfo({ equity: "400" }));
    const original = exchange.setLeverage;
    exchange.setLeverage = async (asset, leverage) => {
      const outcome = await original(asset, leverage);
      await store.setControls({ paused: true, updatedAt: AS_OF, updatedBy: "test" });
      return outcome;
    };
    const run = await new Runner(runnerDeps).executeRun(AS_OF);
    expect(run.status).toBe("failed");
    expect(run.error).toBe("execution paused");
    expect(exchange.recorded()).toHaveLength(1);
  });

  test("binds signed leverage and order actions to the run's expiry (runAt + runTtlSeconds)", async () => {
    const { runner, exchange } = setup(fakeInfo({ equity: "400" }));
    await runner.executeRun(AS_OF);
    expect(exchange.recorded()).toHaveLength(3);
    for (const request of exchange.recorded()) {
      expect((request.payload as { expiresAfter: number }).expiresAfter).toBe((AS_OF + 300) * 1000);
    }
  });

  test("order errors fail the run and preserve per-order outcomes", async () => {
    const { runnerDeps, exchange } = setup(fakeInfo({ equity: "400" }));
    exchange.submit = async () => [
      { asset: "BTC", status: "filled", filledSize: "0.012", avgPx: "100000" },
      { asset: "ETH", status: "error", error: "insufficient margin" },
    ];
    const run = await new Runner(runnerDeps).executeRun(AS_OF);
    expect(run.status).toBe("failed");
    expect(run.error).toContain("insufficient margin");
    expect(run.results?.map((r) => r.status)).toEqual(["filled", "error"]);
  });

  test("control-store outage between batches preserves earlier fills and stops", async () => {
    const { runnerDeps, exchange, store } = setup(fakeInfo({ equity: "400" }));
    exchange.submit = async (_orders, _cloids, shouldStop) => {
      expect(await shouldStop?.()).toBe(false);
      store.getControls = async () => { throw new Error("database offline"); };
      expect(await shouldStop?.()).toBe(true);
      return [
        { asset: "BTC", status: "filled", filledSize: "0.012", avgPx: "100000" },
        { asset: "ETH", status: "not_sent" },
      ];
    };
    const run = await new Runner(runnerDeps).executeRun(AS_OF);
    expect(run.status).toBe("failed");
    expect(run.error).toBe("execution guard failed: database offline");
    expect(run.results?.map((r) => r.status)).toEqual(["filled", "not_sent"]);
    expect((await store.recentRuns(1))[0]).toEqual(run);
  });

  test("unknown exchange outcome pauses subsequent runs for reconciliation", async () => {
    const { runnerDeps, exchange, store } = setup(fakeInfo({ equity: "400" }));
    let submissions = 0;
    exchange.submit = async (orders, cloids, _stop, _expiry, journal) => {
      submissions++;
      await journal?.beforeDispatch(0, orders, cloids);
      const results = [{ asset: "BTC", status: "unknown" as const, error: "response lost" }];
      await journal?.afterResponse(0, results);
      return results;
    };
    const runner = new Runner(runnerDeps);
    const run = await runner.executeRun(AS_OF);
    expect(run.status).toBe("failed");
    expect(run.error).toContain("reconcile order IDs");
    expect((await store.getControls()).paused).toBe(true);
    const next = await runner.executeRun(AS_OF + 600);
    expect(next.status).toBe("skipped_paused");
    expect(submissions).toBe(1);
    const [batch] = await store.unresolvedOrderBatches();
    expect(batch).toMatchObject({ state: "uncertain", runId: run.id });
    await store.reconcileOrderBatch(batch.id, "operator", "Verified all client order IDs and current positions against the exchange", AS_OF * 1000);
    expect(await store.unresolvedOrderBatches()).toEqual([]);
  });

  test("a batch left dispatching after a crash blocks the next run", async () => {
    const { runner, store, exchange } = setup(fakeInfo({ equity: "400" }));
    await store.beginOrderBatch({ id: "orphaned:0", runId: "orphaned", createdAt: AS_OF * 1000, orders: [], cloids: [], kind: "orders" });
    const next = await runner.executeRun(AS_OF + 600);
    expect(next.status).toBe("skipped_paused");
    expect(next.error).toContain("need reconciliation");
    expect((await store.getControls()).paused).toBe(true);
    expect(exchange.recorded()).toEqual([]);
  });

  test("sets leverage once per asset across runs", async () => {
    const { runner, exchange, overrides } = setup(fakeInfo({ equity: "400" }));
    overrides.set(AS_OF + 600, { exposures: [{ asset: "BTC", exposureE9: 6_000_000_000n }] });
    await runner.executeRun(AS_OF);
    await runner.executeRun(AS_OF + 600);
    const types = exchange.recorded().map((r) => (r.payload as { action: { type: string } }).action.type);
    expect(types.filter((t) => t === "updateLeverage")).toHaveLength(2);
  });

  test("skips while paused", async () => {
    const { runner, store, exchange } = setup(fakeInfo({ equity: "400" }));
    await store.setControls({ paused: true, updatedAt: 1, updatedBy: "test" });
    const run = await runner.executeRun(AS_OF);
    expect(run.status).toBe("skipped_paused");
    expect(exchange.recorded()).toEqual([]);
  });

  test("sizes targets with our live equity at execution time", async () => {
    // Same targets, account doubled to $800: BTC target $2,400.
    const { runner } = setup(fakeInfo({ equity: "800" }));
    const run = await runner.executeRun(AS_OF);
    expect(run.plan?.orders.find((o) => o.asset === "BTC")?.size).toBe("0.024");
  });

  test("rejects exposures beyond the gross leverage bound and alerts", async () => {
    const { runner, alerts, overrides } = setup(fakeInfo({ equity: "400" }));
    overrides.set(AS_OF, { exposures: [{ asset: "BTC", exposureE9: 60_000_000_000n }] });
    const run = await runner.executeRun(AS_OF);
    expect(run.status).toBe("failed");
    expect(run.error).toBe("gross exposure 60.00× exceeds 50×");
    expect(alerts).toHaveLength(1);
  });

  test("uncertain leverage update is journaled and prevents all later orders", async () => {
    const s = setup(fakeInfo({ equity: "400", core: [["ETH", "0.1"]] }));
    const original = s.exchange.setLeverage;
    s.exchange.setLeverage = async (assetId, lev) => {
      if (assetId === 0) throw new Error("Invalid leverage value");
      return original(assetId, lev);
    };
    // BTC (asset 0) opens: its leverage fails. ETH reduces from $400 to −$350: a flip, not reduce-only,
    // so its leverage is set and it trades.
    const run = await s.runner.executeRun(AS_OF);
    expect(run.status).toBe("failed");
    expect(run.error).toBe("Invalid leverage value");
    expect(s.exchange.recorded().filter((r) => (r.payload as { action: { type: string } }).action.type === "order")).toEqual([]);
    expect(await s.store.unresolvedOrderBatches()).toMatchObject([{ kind: "leverage", details: { asset: "BTC", assetId: 0 } }]);
  });

  test("a definitive leverage refusal skips only that asset; the run continues unpaused", async () => {
    const s = setup(fakeInfo({ equity: "400", core: [["ETH", "0.1"]] }));
    const original = s.exchange.setLeverage;
    s.exchange.setLeverage = async (assetId, lev, expires) => assetId === 0 ? { rejected: "Invalid leverage value" } : original(assetId, lev, expires);
    const run = await s.runner.executeRun(AS_OF);
    expect(run.plan?.skipped).toContainEqual(expect.objectContaining({ asset: "BTC", reason: "LEVERAGE_FAILED" }));
    expect(run.plan?.orders.map((o) => o.asset)).not.toContain("BTC");
    expect(run.status).toBe("executed");
    expect(await s.store.unresolvedOrderBatches()).toEqual([]);
    expect((await s.store.getControls()).paused).toBe(false);
  });

  test("doesn't execute a run that expired while queued", async () => {
    const s = setup(fakeInfo({ equity: "400" }));
    const late = new Runner({ ...s.runnerDeps, now: () => (AS_OF + 301) * 1000 });
    const run = await late.executeRun(AS_OF);
    expect(run).toMatchObject({ status: "failed", error: "run expired before execution" });
  });

  test("cancels a slow run before it submits, and never overlaps the next run", async () => {
    let release: () => void = () => {};
    const hang = new Promise<void>((r) => (release = r));
    let first = true;
    const base = fakeInfo({ equity: "400" });
    const s = setup((async (req: Record<string, unknown>) => {
      if (req.type === "portfolio" && first) {
        first = false;
        await hang;
      }
      return base(req);
    }) as InfoFn);
    const slow = s.runner.executeRun(AS_OF);
    const next = s.runner.executeRun(AS_OF + 600);
    await Bun.sleep(1_100); // past the 1 s timeout
    expect(s.alerts[0]).toContain("still running after 1s");
    // The queue waits for the slow run: the next one hasn't started.
    expect(s.exchange.recorded()).toEqual([]);
    release();
    const [a, b] = await Promise.all([slow, next]);
    expect(a).toMatchObject({ status: "failed", error: "run timed out after 1s" });
    expect(b.status).toBe("executed");
    // Only the second run sent anything.
    const orders = s.exchange.recorded().filter((r) => (r.payload as { action: { type: string } }).action.type === "order");
    expect(orders).toHaveLength(1);
  });

  test("records HL read failures as failed runs", async () => {
    const { runner } = setup((async () => {
      throw new Error("HL down");
    }) as InfoFn);
    const run = await runner.executeRun(AS_OF);
    expect(run).toMatchObject({ status: "failed", error: "HL down" });
  });

  test("runs one at a time", async () => {
    let active = 0;
    let maxActive = 0;
    const base = fakeInfo({ equity: "400" });
    const slow = (async (req: Record<string, unknown>) => {
      active++;
      maxActive = Math.max(maxActive, active);
      await Bun.sleep(5);
      active--;
      return base(req);
    }) as InfoFn;
    const { runner } = setup(slow);
    await Promise.all([runner.executeRun(AS_OF), runner.executeRun(AS_OF + 600)]);
    // loadMarkets + loadAccount run in parallel within a run (≤ 4 concurrent reads),
    // but two runs never overlap.
    expect(maxActive).toBeLessThanOrEqual(4);
  });
});

describe("Runner.flatten", () => {
  test("closes every position reduce-only, even while paused", async () => {
    const { runner, store } = setup(fakeInfo({ equity: "400", core: [["BTC", "0.002"]], xyz: [["xyz:MSFT", "-0.3"]] }));
    await store.setControls({ paused: true, updatedAt: 1, updatedBy: "test" });
    const run = await runner.flatten("test");
    expect(run.plan?.orders.map((o) => [o.asset, o.assetId, o.isBuy, o.reduceOnly])).toEqual([
      ["BTC", 0, false, true],
      ["xyz:MSFT", 110_000, true, true],
    ]);
  });
});

describe("app routes", () => {
  const make = (adminToken?: string, extra: Partial<AppDeps> = {}) => {
    const s = setup(fakeInfo({ equity: "400", core: [["BTC", "0.002"]] }));
    const logs: string[] = [];
    const app = createApp({
      // 10 s after the :x0 run AS_OF.
      now: () => AS_OF * 1000 + 10_000,
      runner: s.runner,
      store: s.store,
      adminToken,
      status: () => ({ dryRun: true }),
      log: (m) => void logs.push(m),
      ...extra,
    });
    return { app, ...s, logs };
  };
  const post = (path: string, init: RequestInit = {}) => new Request(`http://x${path}`, { method: "POST", ...init });

  const cron = (path = "/api/executor/cron/run", secret = "c") => new Request(`http://x${path}`, { headers: { authorization: `Bearer ${secret}` } });

  test("GET /cron/run runs the due slot once; a second trigger is a duplicate", async () => {
    const { app, store } = make(undefined, { cronSecret: "c" });
    const first = await app(cron());
    expect(await first.json()).toMatchObject({ runId: `mirror-${AS_OF}`, kind: "mirror", status: "executed" });
    expect(await (await app(cron())).json()).toEqual({ status: "duplicate", runId: `mirror-${AS_OF}` });
    expect((await store.recentRuns(5)).map((r) => r.status)).toEqual(["executed"]);
  });

  test("GET /cron/run needs the cron secret and does nothing outside the grace window", async () => {
    expect((await make(undefined, { cronSecret: "c" }).app(cron(undefined, "wrong"))).status).toBe(401);
    expect((await make().app(cron())).status).toBe(401);
    const late = make(undefined, { cronSecret: "c", now: () => (AS_OF + 300) * 1000 });
    expect(await (await late.app(cron())).json()).toEqual({ status: "no run due" });
    expect(await late.store.recentRuns(5)).toEqual([]);
  });

  test("POST /admin/run runs a given :x0 slot and refuses others", async () => {
    const { app, store } = make("s3cret");
    const run = (runAt: unknown) => app(post("/admin/run", { headers: { authorization: "Bearer s3cret" }, body: JSON.stringify({ runAt }) }));
    expect((await run(AS_OF + 1)).status).toBe(400);
    expect((await run(AS_OF + 6000)).status).toBe(400);
    expect(await (await run(AS_OF + 600)).json()).toMatchObject({ runId: `mirror-${AS_OF + 600}`, status: "executed" });
    expect((await store.recentRuns(1))[0].evidence).toMatchObject({ snapshotHash: `0x${"cd".repeat(32)}`, configurationHash: CONFIGURATION });
  });

  test("serves the same routes under /api/executor (vercel.json)", async () => {
    const { app } = make();
    expect((await app(new Request("http://x/api/executor/health"))).status).toBe(200);
    expect((await app(new Request("http://x/api/executor/runs?limit=1"))).status).toBe(200);
    expect((await app(new Request("http://x/api/executorx/health"))).status).toBe(404);
  });

  test("GET /cron/watchdog needs the cron secret", async () => {
    const watchdog = async () => ({ alerted: false });
    const get = (headers: Record<string, string> = {}) => new Request("http://x/api/executor/cron/watchdog", { headers });
    expect((await make(undefined, { watchdog, cronSecret: "c" }).app(get())).status).toBe(401);
    expect((await make(undefined, { watchdog }).app(get({ authorization: "Bearer " }))).status).toBe(401);
    const ok = await make(undefined, { watchdog, cronSecret: "c" }).app(get({ authorization: "Bearer c" }));
    expect(await ok.json()).toEqual({ alerted: false });
  });

  test("admin routes need the bearer token", async () => {
    const { app, store } = make("s3cret");
    expect((await app(post("/admin/pause"))).status).toBe(401);
    expect((await app(post("/admin/pause", { headers: { authorization: "Bearer wrong!" } }))).status).toBe(401);
    const ok = await app(post("/admin/pause", { headers: { authorization: "Bearer s3cret", "x-operator": "james" } }));
    expect(ok.status).toBe(200);
    expect(await store.getControls()).toMatchObject({ paused: true, updatedBy: "james" });
  });

  test("uncertain order batches can only be reconciled with authenticated evidence", async () => {
    const { app, store } = make("s3cret");
    await store.beginOrderBatch({
      id: "run:0", runId: "run", createdAt: AS_OF * 1000,
      orders: [], cloids: [`0x${"12".repeat(16)}` as `0x${string}`], kind: "orders",
    });
    const get = (headers: Record<string, string> = {}) => new Request("http://x/admin/order-batches", { headers });
    expect((await app(get())).status).toBe(401);
    const listing = await app(get({ authorization: "Bearer s3cret" }));
    expect(await listing.json()).toMatchObject([{ id: "run:0", state: "dispatching" }]);
    const resume = await app(post("/admin/resume", { headers: { authorization: "Bearer s3cret" } }));
    expect(resume.status).toBe(409);
    expect(await resume.json()).toMatchObject({ unresolved: 1, paused: true });
    const invalid = await app(post("/admin/reconcile-batch", {
      headers: { authorization: "Bearer s3cret", "content-type": "application/json" },
      body: JSON.stringify({ id: "run:0", evidence: "looked" }),
    }));
    expect(invalid.status).toBe(400);
    const resolved = await app(post("/admin/reconcile-batch", {
      headers: { authorization: "Bearer s3cret", "x-operator": "james", "content-type": "application/json" },
      body: JSON.stringify({ id: "run:0", evidence: "Verified client order ID, fills and positions against Hyperliquid" }),
    }));
    expect(await resolved.json()).toMatchObject({ reconciled: "run:0", unresolved: 0, paused: true });
    expect(await store.unresolvedOrderBatches()).toEqual([]);
    expect((await store.getControls()).paused).toBe(true);
  });

  test("reconciliation waits for an active run (the run lock)", async () => {
    const { app, store, runner } = make("s3cret");
    await store.beginOrderBatch({
      id: "in-flight:0", runId: "in-flight", createdAt: AS_OF * 1000,
      orders: [], cloids: [], kind: "orders",
    });
    let entered!: () => void;
    let release!: () => void;
    const locked = new Promise<void>((resolve) => { entered = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const owner = runner.exclusive(async () => { entered(); await gate; });
    await locked;
    const reconciliation = app(post("/admin/reconcile-batch", {
      headers: { authorization: "Bearer s3cret", "content-type": "application/json" },
      body: JSON.stringify({ id: "in-flight:0", evidence: "Verified exchange status, fills and account positions" }),
    }));
    await Bun.sleep(10);
    expect(await store.unresolvedOrderBatches()).toMatchObject([{ id: "in-flight:0", state: "dispatching" }]);
    release();
    await owner;
    expect((await reconciliation).status).toBe(200);
    expect(await store.unresolvedOrderBatches()).toEqual([]);
  });

  test("pause does not wait for an active run", async () => {
    const { app, store, runner } = make("s3cret");
    let entered!: () => void;
    let release!: () => void;
    const locked = new Promise<void>((resolve) => { entered = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const owner = runner.exclusive(async () => { entered(); await gate; });
    await locked;
    try {
      const response = await Promise.race([
        app(post("/admin/pause", { headers: { authorization: "Bearer s3cret" } })),
        Bun.sleep(100).then(() => null),
      ]);
      expect(response).not.toBeNull();
      expect(await store.getControls()).toMatchObject({ paused: true });
    } finally {
      release();
      await owner;
    }
  });

  test("reconciling an unknown batch is a 409 that leaves the controls alone", async () => {
    const { app, store } = make("s3cret");
    const before = await store.getControls();
    const response = await app(post("/admin/reconcile-batch", {
      headers: { authorization: "Bearer s3cret", "content-type": "application/json" },
      body: JSON.stringify({ id: "no-such-batch:0", evidence: "Verified exchange status, fills and account positions" }),
    }));
    expect(response.status).toBe(409);
    expect(await store.getControls()).toEqual(before);
  });

  test("resume answers 409 when another process holds the run lock", async () => {
    const busy = { acquire: async () => { throw new Error("another executor process held the run lock for 1s"); } };
    const s = setup(fakeInfo({ equity: "400" }));
    const runner = new Runner({ ...s.runnerDeps, lock: busy });
    const app = createApp({ runner, store: s.store, adminToken: "s3cret", status: () => ({}), log: () => undefined });
    const response = await app(post("/admin/resume", { headers: { authorization: "Bearer s3cret" } }));
    expect(response.status).toBe(409);
  });

  test("admin routes are disabled without a configured token", async () => {
    expect((await make().app(post("/admin/pause", { headers: { authorization: "Bearer " } }))).status).toBe(401);
  });

  test("flatten pauses and closes", async () => {
    const { app, store } = make("s3cret");
    const res = await app(post("/admin/flatten", { headers: { authorization: "Bearer s3cret" } }));
    expect(await res.json()).toMatchObject({ kind: "flatten", status: "executed" });
    expect((await store.getControls()).paused).toBe(true);
  });

  test("GET /runs serializes bigint target fields and allows browser reads", async () => {
    const { app, runner } = make();
    await runner.executeRun(AS_OF);
    const res = await app(new Request("http://x/runs?limit=5"));
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    const runs = (await res.json()) as { runId: string }[];
    expect(runs[0].runId).toBe(`mirror-${AS_OF}`);
  });

  test("GET /runs?summary=1 leaves out plans and evidence", async () => {
    const { app, runner } = make();
    await runner.executeRun(AS_OF);
    const [run] = (await (await app(new Request("http://x/runs?summary=1&limit=1000"))).json()) as Record<string, unknown>[];
    expect(run).toMatchObject({ runId: `mirror-${AS_OF}`, status: "executed", orders: expect.any(Number) });
    expect(run).not.toHaveProperty("evidence");
    expect(run).not.toHaveProperty("plan");
  });

  test("GET /equity: live runs only, on the run clock; every executed run counted", async () => {
    const { app, store, runner } = make();
    await runner.executeRun(AS_OF); // a dry run
    const live = AS_OF + 600;
    await store.saveRun({ id: "live", runId: `mirror-${live}`, kind: "mirror", status: "executed", dryRun: false, startedAt: live * 1000 + 3000, finishedAt: live * 1000 + 4000, equityUsd: 470 });
    const res = await app(new Request("http://x/equity"));
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    expect(await res.json()).toEqual({ runs: 2, points: [[live * 1000, 470]] });
  });
});

describe("cronWatchdog", () => {
  const MIN = 60_000;
  const check = async (finishedAt: number[], now: number) => {
    const alerts: string[] = [];
    const store = new MemoryStore();
    for (const [i, t] of finishedAt.entries()) {
      await store.saveRun({ id: `r${i}`, runId: `mirror-${i}`, kind: "mirror", status: "executed", dryRun: true, startedAt: t - 1000, finishedAt: t });
    }
    const result = await cronWatchdog({ store, alert: async (m) => void alerts.push(m), now: () => now, afterMs: 25 * MIN, everyMs: 5 * MIN })();
    return { result, alerts };
  };

  test("stays quiet before the first run and while runs finish", async () => {
    expect((await check([], 100 * MIN)).alerts).toEqual([]);
    expect((await check([0, 10 * MIN], 34 * MIN)).alerts).toEqual([]);
  });

  test("alerts once: on the first check past the threshold", async () => {
    expect((await check([0], 24 * MIN)).alerts).toEqual([]);
    expect((await check([0], 26 * MIN)).alerts).toEqual(["no finished run for 26 min (last: mirror-0)"]);
    expect((await check([0], 30.5 * MIN)).alerts).toHaveLength(1); // cron jitter slack
    expect((await check([0], 31.5 * MIN)).alerts).toEqual([]);
  });
});

describe("loadConfig", () => {
  const base = {
    FROZEN_CONFIGURATION_HASH: CONFIGURATION,
    HL_ACCOUNT: ACCOUNT,
  };
  const production = { ...base, NODE_ENV: "production", ADMIN_TOKEN: "x", DATABASE_URL: "postgres://db", BACKEND_URL: "https://perpparrot.vercel.app/api/backend" };

  test("defaults to dry run against the local backend", () => {
    expect(loadConfig(base)).toMatchObject({ dryRun: true, backendUrl: "http://localhost:8788", runTtlSeconds: 300, slippageBps: 50, marginCap: 0.95 });
  });

  test("production needs an admin token, durable storage and the backend URL", () => {
    expect(() => loadConfig({ ...production, ADMIN_TOKEN: undefined })).toThrow("ADMIN_TOKEN is required");
    expect(() => loadConfig({ ...production, DATABASE_URL: undefined })).toThrow("DATABASE_URL is required");
    expect(() => loadConfig({ ...production, BACKEND_URL: undefined })).toThrow("BACKEND_URL is required");
    expect(loadConfig(production)).toMatchObject({ production: true, dryRun: true });
  });

  test("requires the API wallet key to trade live", () => {
    expect(() => loadConfig({ ...base, DRY_RUN: "false" })).toThrow("HL_API_WALLET_KEY is required");
    const key = `0x${"22".repeat(32)}` as Hex;
    expect(loadConfig({ ...base, DRY_RUN: "false", HL_API_WALLET_KEY: key }).dryRun).toBe(false);
  });

  test("on Vercel: production rules, dry run only, Postgres and a cron secret", () => {
    const vercel = { ...production, NODE_ENV: undefined, VERCEL: "1", CRON_SECRET: "c" };
    expect(loadConfig(vercel)).toMatchObject({ vercel: true, production: true, dryRun: true, cronSecret: "c" });
    expect(() => loadConfig({ ...vercel, ADMIN_TOKEN: undefined })).toThrow("ADMIN_TOKEN is required");
    expect(() => loadConfig({ ...vercel, DATABASE_URL: undefined })).toThrow("DATABASE_URL is required on Vercel");
    expect(() => loadConfig({ ...vercel, CRON_SECRET: undefined })).toThrow("CRON_SECRET is required on Vercel");
    expect(() => loadConfig({ ...vercel, DRY_RUN: "false", HL_API_WALLET_KEY: `0x${"22".repeat(32)}` })).toThrow("DRY_RUN=false is not allowed on Vercel");
  });

  test("validates hex settings, numbers and the backend URL", () => {
    expect(() => loadConfig({ ...base, HL_ACCOUNT: "0x12" })).toThrow("HL_ACCOUNT must be");
    expect(() => loadConfig({ ...base, SLIPPAGE_BPS: "abc" })).toThrow("SLIPPAGE_BPS must be a number");
    expect(() => loadConfig({ ...base, BACKEND_URL: "ftp://x" })).toThrow("BACKEND_URL must be");
  });
});

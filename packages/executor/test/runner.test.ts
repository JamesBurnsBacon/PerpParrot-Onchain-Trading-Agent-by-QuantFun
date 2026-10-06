import { describe, expect, test } from "bun:test";
import type { Hex } from "viem";
import { createApp } from "../src/app";
import { loadConfig } from "../src/config";
import { createExchange } from "../src/exchange";
import type { InfoFn } from "../src/hyperliquid";
import { cloidFor, Runner } from "../src/runner";
import { MemoryStore } from "../src/store";
import { verifyEnvelope } from "../src/verify";
import { ACCOUNT, AS_OF, body, envelope, keys, CONFIGURATION, registry } from "./helpers";

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
  const exchange = createExchange({ dryRun: true });
  const alerts: string[] = [];
  const runnerDeps = {
    store,
    exchange,
    info,
    alert: async (m: string) => void alerts.push(m),
    now: () => AS_OF * 1000,
    config: {
      account: ACCOUNT,
      maxGrossLeverage: 50,
      runTimeoutMs: 1_000,
      plan: { minOrderUsd: 10, driftFraction: 0.1, marginCap: 0.95, slippageBps: 50 },
    },
  };
  return { store, exchange, runner: new Runner(runnerDeps), runnerDeps, alerts };
};

const verified = async (b = body()) => verifyEnvelope(await envelope(keys.slice(0, 2), { body: b }), registry);

describe("Runner.executeReport (dry run)", () => {
  test("plans against the live account and signs one IOC batch", async () => {
    const { runner, exchange, store } = setup(fakeInfo({ equity: "400", core: [["ETH", "-0.05"]] }));
    const report = await verified();
    const run = await runner.executeReport(report, {});

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
      c: cloidFor(report.id, "BTC"),
    });
    expect(orderReq.signature.r).toMatch(/^0x[0-9a-f]{64}$/);
    expect(orderReq.nonce).toBeGreaterThan(0);
    expect(await store.recentRuns(1)).toEqual([run]);
  });

  test("sets leverage once per asset across runs", async () => {
    const { runner, exchange } = setup(fakeInfo({ equity: "400" }));
    await runner.executeReport(await verified(), {});
    await runner.executeReport(await verified(body({ runId: "mirror-2", exposures: [{ asset: "BTC", exposureE9: 6_000_000_000n }] })), {});
    const types = exchange.recorded().map((r) => (r.payload as { action: { type: string } }).action.type);
    expect(types.filter((t) => t === "updateLeverage")).toHaveLength(2);
  });

  test("skips while paused", async () => {
    const { runner, store, exchange } = setup(fakeInfo({ equity: "400" }));
    await store.setControls({ paused: true, updatedAt: 1, updatedBy: "test" });
    const run = await runner.executeReport(await verified(), {});
    expect(run.status).toBe("skipped_paused");
    expect(exchange.recorded()).toEqual([]);
  });

  test("sizes targets with our live equity at execution time", async () => {
    // Same report, account doubled to $800: BTC target $2,400.
    const { runner } = setup(fakeInfo({ equity: "800" }));
    const run = await runner.executeReport(await verified(), {});
    expect(run.plan?.orders.find((o) => o.asset === "BTC")?.size).toBe("0.024");
  });

  test("rejects exposures beyond the gross leverage bound and alerts", async () => {
    const { runner, alerts } = setup(fakeInfo({ equity: "400" }));
    const run = await runner.executeReport(await verified(body({ exposures: [{ asset: "BTC", exposureE9: 60_000_000_000n }] })), {});
    expect(run.status).toBe("failed");
    expect(run.error).toBe("gross exposure 60.00× exceeds 50×");
    expect(alerts).toHaveLength(1);
  });

  test("skips only the asset whose leverage update fails; reductions still go out", async () => {
    const s = setup(fakeInfo({ equity: "400", core: [["ETH", "0.1"]] }));
    const original = s.exchange.setLeverage;
    s.exchange.setLeverage = async (assetId, lev) => {
      if (assetId === 0) throw new Error("Invalid leverage value");
      return original(assetId, lev);
    };
    // BTC (asset 0) opens: its leverage fails. ETH reduces from $400 to −$350: a flip, not reduce-only,
    // so its leverage is set and it trades.
    const run = await s.runner.executeReport(await verified(), {});
    expect(run.status).toBe("executed");
    expect(run.plan?.orders.map((o) => o.asset)).toEqual(["ETH"]);
    expect(run.plan?.skipped).toContainEqual(expect.objectContaining({ asset: "BTC", reason: "LEVERAGE_FAILED" }));
    expect(s.alerts[0]).toContain("leverage update failed for BTC");
  });

  test("doesn't execute a report that expired while queued", async () => {
    const s = setup(fakeInfo({ equity: "400" }));
    const late = new Runner({ ...s.runnerDeps, now: () => (AS_OF + 301) * 1000 });
    const run = await late.executeReport(await verified(), {});
    expect(run).toMatchObject({ status: "failed", error: "report expired before execution" });
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
    const slow = s.runner.executeReport(await verified(), {});
    const next = s.runner.executeReport(await verified(body({ runId: "mirror-2" })), {});
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
    const run = await runner.executeReport(await verified(), {});
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
    const a = await verified();
    const b = await verified(body({ runId: "mirror-2" }));
    await Promise.all([runner.executeReport(a, {}), runner.executeReport(b, {})]);
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
  const make = (adminToken?: string) => {
    const s = setup(fakeInfo({ equity: "400", core: [["BTC", "0.002"]] }));
    const logs: string[] = [];
    const app = createApp({
      handler: {
        mode: registry,
        frozenConfigurationHash: CONFIGURATION,
        account: ACCOUNT,
        now: () => AS_OF + 10,
        maxLeadSeconds: 60,
        maxTtlSeconds: 300,
      },
      runner: s.runner,
      store: s.store,
      adminToken,
      status: () => ({ dryRun: true }),
      log: (m) => void logs.push(m),
    });
    return { app, ...s, logs };
  };
  const post = (path: string, init: RequestInit = {}) => new Request(`http://x${path}`, { method: "POST", ...init });

  test("POST /reports accepts, then answers duplicates", async () => {
    const { app, store } = make();
    const env = await envelope(keys.slice(0, 2));
    const first = await app(post("/reports", { body: JSON.stringify(env) }));
    expect(first.status).toBe(200);
    expect(await first.json()).toMatchObject({ status: "accepted" });
    const dup = await app(post("/reports", { body: JSON.stringify(await envelope(keys.slice(2, 4))) }));
    expect(await dup.json()).toMatchObject({ status: "duplicate" });
    await Bun.sleep(20);
    expect((await store.recentRuns(5)).map((r) => r.status)).toEqual(["executed"]);
  });

  test("POST /reports rejects invalid JSON", async () => {
    expect((await make().app(post("/reports", { body: "{" }))).status).toBe(400);
  });

  test("admin routes need the bearer token", async () => {
    const { app, store } = make("s3cret");
    expect((await app(post("/admin/pause"))).status).toBe(401);
    expect((await app(post("/admin/pause", { headers: { authorization: "Bearer wrong!" } }))).status).toBe(401);
    const ok = await app(post("/admin/pause", { headers: { authorization: "Bearer s3cret", "x-operator": "james" } }));
    expect(ok.status).toBe(200);
    expect(await store.getControls()).toMatchObject({ paused: true, updatedBy: "james" });
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

  test("GET /runs serializes bigint report fields and allows browser reads", async () => {
    const { app } = make();
    await app(post("/reports", { body: JSON.stringify(await envelope(keys.slice(0, 2))) }));
    await Bun.sleep(20);
    const res = await app(new Request("http://x/runs?limit=5"));
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    const runs = (await res.json()) as { runId: string }[];
    expect(runs[0].runId).toBe(`mirror-${AS_OF}`);
  });

  test("GET /runs?summary=1 leaves out plans and reports", async () => {
    const { app } = make();
    await app(post("/reports", { body: JSON.stringify(await envelope(keys.slice(0, 2))) }));
    await Bun.sleep(20);
    const [run] = (await (await app(new Request("http://x/runs?summary=1&limit=1000"))).json()) as Record<string, unknown>[];
    expect(run).toMatchObject({ runId: `mirror-${AS_OF}`, status: "executed", orders: expect.any(Number) });
    expect(run).not.toHaveProperty("envelope");
    expect(run).not.toHaveProperty("plan");
  });
});

describe("loadConfig", () => {
  const base = {
    WORKFLOW_OWNER: "0xc5feb3cf878c9ba42a776e9edf62a4558ab08b85",
    FROZEN_CONFIGURATION_HASH: CONFIGURATION,
    HL_ACCOUNT: ACCOUNT,
  };

  test("defaults to dry run with report verification", () => {
    expect(loadConfig(base)).toMatchObject({ dryRun: true, verifyReports: true, slippageBps: 50, marginCap: 0.95 });
  });

  test("refuses unverified reports in production", () => {
    expect(() => loadConfig({ ...base, NODE_ENV: "production", VERIFY_REPORTS: "false", ADMIN_TOKEN: "x" })).toThrow(
      "not allowed in production",
    );
  });

  test("requires an admin token in production", () => {
    expect(() => loadConfig({ ...base, NODE_ENV: "production" })).toThrow("ADMIN_TOKEN is required");
  });

  test("live trading in production needs the workflow and DON pins", () => {
    const live = { ...base, NODE_ENV: "production", ADMIN_TOKEN: "x", DRY_RUN: "false", HL_API_WALLET_KEY: `0x${"22".repeat(32)}` };
    expect(() => loadConfig(live)).toThrow("WORKFLOW_NAME and DON_ID are required");
    expect(loadConfig({ ...live, WORKFLOW_NAME: `0x${"ab".repeat(10)}`, DON_ID: "1" })).toMatchObject({ dryRun: false, donId: 1 });
    // Dry run in production is fine without them (that's how you learn their values).
    expect(loadConfig({ ...base, NODE_ENV: "production", ADMIN_TOKEN: "x" }).dryRun).toBe(true);
  });

  test("refuses to trade live on unverified reports", () => {
    const key = `0x${"22".repeat(32)}` as Hex;
    expect(() => loadConfig({ ...base, DRY_RUN: "false", HL_API_WALLET_KEY: key, VERIFY_REPORTS: "false" })).toThrow(
      "only allowed with DRY_RUN",
    );
  });

  test("requires the API wallet key to trade live", () => {
    expect(() => loadConfig({ ...base, DRY_RUN: "false" })).toThrow("HL_API_WALLET_KEY is required");
    const key = `0x${"22".repeat(32)}` as Hex;
    expect(loadConfig({ ...base, DRY_RUN: "false", HL_API_WALLET_KEY: key }).dryRun).toBe(false);
  });

  test("validates hex settings and numbers", () => {
    expect(() => loadConfig({ ...base, HL_ACCOUNT: "0x12" })).toThrow("HL_ACCOUNT must be");
    expect(() => loadConfig({ ...base, SLIPPAGE_BPS: "abc" })).toThrow("SLIPPAGE_BPS must be a number");
  });
});

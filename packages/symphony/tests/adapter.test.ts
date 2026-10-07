import { describe, it, expect } from "vitest";
import {
  loadDashboard,
  countPlannedOrders,
  runSchema,
  resolveApiBase,
} from "../src/data/adapter";
import { sources } from "../src/data";
describe("evidence boundary", () => {
  it("uses same-origin defaults for blank URLs and rejects protocols, credentials and suffixes", () => {
    expect(resolveApiBase("  ", "/api/backend")).toBe("/api/backend");
    expect(resolveApiBase("", "/api/executor")).toBe("/api/executor");
    expect(() =>
      resolveApiBase("ftp://example.test", "/api/backend"),
    ).toThrow();
    expect(() =>
      resolveApiBase("https://user:secret@example.test", "/api/backend"),
    ).toThrow();
    expect(() =>
      resolveApiBase("/api/backend?token=x", "/api/backend"),
    ).toThrow();
    expect(() =>
      resolveApiBase("https://example.test/api#route", "/api/backend"),
    ).toThrow();
  });
  it("reports endpoint timeout as unavailable with a useful recovery step", async () => {
    const result = await loadDashboard({
      mode: "live",
      fetcher: (async () => {
        throw new DOMException("Timeout", "TimeoutError");
      }) as typeof fetch,
    });
    expect(
      Object.values(result.evidence).every(
        (r) =>
          r.status === "unavailable" &&
          r.error.includes("Check the service URL"),
      ),
    ).toBe(true);
  });
  it("never invokes the network in explicit demo mode", async () => {
    let called = false;
    const result = await loadDashboard({
      mode: "demo",
      fetcher: (async () => {
        called = true;
        throw Error("unexpected");
      }) as typeof fetch,
    });
    expect(called).toBe(false);
    expect(result.mode).toBe("demo");
    expect(result.sources).toHaveLength(5);
  });
  it("does not replace a failed live request with demo data", async () => {
    const result = await loadDashboard({
      mode: "live",
      fetcher: (async () =>
        new Response("{}", { status: 503 })) as typeof fetch,
    });
    expect(result.mode).toBe("live");
    expect(result.sources).toEqual([]);
    expect(
      Object.values(result.evidence).every((r) => r.status === "unavailable"),
    ).toBe(true);
  });
  it("rejects malformed successful live responses", async () => {
    const result = await loadDashboard({
      mode: "live",
      fetcher: (async () =>
        new Response(JSON.stringify({ invented: true }), {
          status: 200,
        })) as typeof fetch,
    });
    expect(
      Object.values(result.evidence).every((r) => r.status === "unavailable"),
    ).toBe(true);
  });
  it("preserves valid original pipeline evidence without inventing source performance", async () => {
    const pipeline = {
      accounts: { listed: 10, fresh: 9, errors: 1 },
      selections: [],
      active: {
        hash: "real-config",
        activated_at: "2026-10-07T00:00:00Z",
        sources: [
          {
            candidate: 12,
            sourceAddress: "0xabc",
            weightUnits: 40,
            ceilingUnits: 60,
          },
        ],
      },
    };
    const result = await loadDashboard({
      mode: "live",
      fetcher: (async (url) =>
        String(url).endsWith("/pipeline")
          ? new Response(JSON.stringify(pipeline))
          : new Response("{}", { status: 503 })) as typeof fetch,
    });
    expect(result.evidence.pipeline).toEqual({
      status: "available",
      data: pipeline,
    });
    expect(result.sources).toEqual([]);
  });
  it("accepts the seven verified read contracts", async () => {
    const payloads: Record<string, unknown> = {
      "/paper": { lastRunAt: null, books: [] },
      "/runs": [],
      "/equity": { runs: 0, points: [] },
      "/status": {
        dryRun: true,
        account: "0xabc",
        controls: { paused: true },
        lastRunAt: null,
      },
      "/exposures": { runAt: 1, exposures: [] },
      "/pipeline": {
        accounts: { listed: 0, fresh: 0, errors: 0 },
        selections: [],
        active: null,
      },
    };
    const result = await loadDashboard({
      mode: "live",
      fetcher: (async (url) => {
        const pathname = new URL(String(url), "https://example.test").pathname;
        const key = Object.keys(payloads).find((k) => pathname.endsWith(k))!;
        return new Response(JSON.stringify(payloads[key]));
      }) as typeof fetch,
    });
    expect(
      Object.values(result.evidence).every((r) => r.status === "available"),
    ).toBe(true);
  });
  it("propagates cancellation instead of disguising it as unavailable data", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      loadDashboard({
        mode: "live",
        signal: controller.signal,
        fetcher: (async () => {
          throw new DOMException("Cancelled", "AbortError");
        }) as typeof fetch,
      }),
    ).rejects.toMatchObject({ name: "AbortError" });
  });
  it("keeps planned orders distinct from fill evidence", () => {
    const run = {
      id: "1",
      runId: "mirror-1",
      kind: "mirror",
      status: "executed",
      dryRun: true,
      startedAt: 1,
      finishedAt: 2,
      plan: {
        orders: [
          {
            asset: "BTC",
            isBuy: true,
            notionalUsd: 100,
            targetUsd: 100,
            currentUsd: 0,
          },
        ],
        skipped: [],
      },
    };
    expect(countPlannedOrders(run)).toBe(1);
    expect(runSchema.parse(run).results).toBeUndefined();
  });
  it("demo allocation preserves signed source and portfolio gross exposures", () => {
    expect(sources.reduce((sum, s) => sum + s.weight, 0)).toBe(100);
    const btc = sources.reduce((sum, s) => sum + s.btc, 0),
      eth = sources.reduce((sum, s) => sum + s.eth, 0);
    expect(btc).toBe(35);
    expect(eth).toBe(12);
    expect(Math.abs(btc) + Math.abs(eth)).toBe(47);
    expect(
      sources.reduce((sum, s) => sum + Math.abs(s.btc) + Math.abs(s.eth), 0),
    ).toBe(59);
  });
});

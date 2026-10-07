import { describe, expect, test } from "bun:test";
import { PacedInfo } from "../src/pipeline/hl";
import { NOWNODES_CAPABLE, makeRoutedFetch, type RouterOptions } from "../src/pipeline/info-router";

const OFFICIAL = "https://api.hyperliquid.xyz/info";
const NOW = "https://hype.nownodes.io/info";

type Call = { url: string; type: string; key: string | null; redirect?: string };
type Reply = Response | Error | ((c: Call) => Response | Error);

// A fake network: `official` and `nownodes` decide each answer; every call is recorded.
const rig = (official: Reply, nownodes: Reply, env: Record<string, string>) => {
  const calls: Call[] = [];
  const logs: string[] = [];
  const answer = (r: Reply, c: Call) => {
    const v = typeof r === "function" ? r(c) : r;
    if (v instanceof Error) throw v;
    return v.clone();
  };
  const fetchImpl = async (url: string, init?: RequestInit) => {
    const c: Call = { url, type: JSON.parse(String(init?.body)).type, key: new Headers(init?.headers).get("api-key"), redirect: init?.redirect };
    calls.push(c);
    return answer(url === NOW ? nownodes : official, c);
  };
  let t = 0;
  const router = makeRoutedFetch({ env: () => env, fetchImpl: fetchImpl as unknown as RouterOptions["fetchImpl"], now: () => (t += 1), log: (m) => logs.push(m) });
  const post = (type: string, extra: Record<string, unknown> = {}, signal?: AbortSignal) =>
    router(OFFICIAL, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ type, ...extra }), signal });
  return { router, post, calls, logs, advance: (ms: number) => (t += ms) };
};

const ok = (body: unknown = { ok: true }) => new Response(JSON.stringify(body), { status: 200 });
const status = (s: number, headers: Record<string, string> = {}) => new Response("x", { status: s, headers });
const only = (calls: Call[], url: string) => calls.filter((c) => c.url === url).length;
const KEY = { NOWNODES_API_KEY: "test-key" };

describe("official mode (the default)", () => {
  test("passes straight through and never touches NOWNodes, even with a key", async () => {
    const r = rig(ok({ a: 1 }), status(500), { ...KEY });
    const res = await r.post("clearinghouseState", { user: "0xabc" });
    expect(await res.json()).toEqual({ a: 1 });
    expect(r.calls).toEqual([{ url: OFFICIAL, type: "clearinghouseState", key: null }]);
  });

  test("an official failure is returned as is (no fallback)", async () => {
    const r = rig(status(429, { "retry-after": "7" }), ok(), { INFO_ROUTING: "official", ...KEY });
    const res = await r.post("clearinghouseState");
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBe("7");
    expect(only(r.calls, NOW)).toBe(0);
  });
});

describe("overflow mode", () => {
  const env = { INFO_ROUTING: "overflow", ...KEY };

  test("a healthy official API means zero NOWNodes calls", async () => {
    const r = rig(ok(), ok(), env);
    for (let i = 0; i < 10; i++) await r.post("clearinghouseState");
    expect(only(r.calls, NOW)).toBe(0);
    expect(r.router.stats().fallbacks).toBe(0);
  });

  test("official 429, 500 and network errors fall over to NOWNodes with the api-key header", async () => {
    for (const bad of [status(429), status(503), new Error("timeout")]) {
      const r = rig(bad, ok({ from: "nownodes" }), env);
      const res = await r.post("clearinghouseState", { user: "0xabc" });
      expect(await res.json()).toEqual({ from: "nownodes" });
      expect(r.calls.map((c) => [c.url, c.key])).toEqual([[OFFICIAL, null], [NOW, "test-key"]]);
      expect(r.router.stats().fallbacks).toBe(1);
    }
  });

  test("methods NOWNodes does not serve never leave the official API", async () => {
    for (const type of ["portfolio", "userFillsByTime", "userFunding", "metaAndAssetCtxs", "vaultDetails", "allMids", "l2Book", "candleSnapshot"]) {
      expect(NOWNODES_CAPABLE.has(type)).toBe(false);
      const r = rig(status(429, { "retry-after": "3" }), ok(), env);
      const res = await r.post(type);
      expect(res.status).toBe(429);
      expect(only(r.calls, NOW)).toBe(0);
    }
  });

  test("both providers failing returns the official answer, Retry-After intact", async () => {
    const r = rig(status(429, { "retry-after": "9" }), status(500), env);
    const res = await r.post("clearinghouseState");
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBe("9");
  });

  test("both providers throwing rethrows the official error", async () => {
    const r = rig(new Error("official down"), new Error("nownodes down"), env);
    await expect(r.post("clearinghouseState")).rejects.toThrow("official down");
  });

  test("without a key it behaves like official mode", async () => {
    const r = rig(status(503), ok(), { INFO_ROUTING: "overflow" });
    expect((await r.post("clearinghouseState")).status).toBe(503);
    expect(only(r.calls, NOW)).toBe(0);
  });

  test("a circuit breaker stops retrying on a NOWNodes that keeps failing, then recovers", async () => {
    const r = rig(status(503), status(500), env);
    for (let i = 0; i < 3; i++) await r.post("clearinghouseState");
    expect(only(r.calls, NOW)).toBe(3);
    expect(r.router.stats().breakerOpen).toBe(true);
    await r.post("clearinghouseState");
    expect(only(r.calls, NOW)).toBe(3); // skipped while the breaker is open
    r.advance(61_000);
    await r.post("clearinghouseState");
    expect(only(r.calls, NOW)).toBe(4); // tried again after the pause
  });
});

describe("split mode", () => {
  test("sends the configured share of capable reads to NOWNodes first, never the others", async () => {
    const r = rig(ok(), ok(), { INFO_ROUTING: "split", INFO_SPLIT_PERCENT: "25", ...KEY });
    for (let i = 0; i < 100; i++) await r.post("clearinghouseState");
    expect(only(r.calls, NOW)).toBe(25);
    for (let i = 0; i < 20; i++) await r.post("portfolio");
    expect(only(r.calls, NOW)).toBe(25);
  });

  test("a NOWNodes 401 or 5xx fails over to the official API within the same read", async () => {
    for (const bad of [status(401), status(502), new Error("reset")]) {
      const r = rig(ok({ from: "official" }), bad, { INFO_ROUTING: "split", INFO_SPLIT_PERCENT: "100", ...KEY });
      const res = await r.post("clearinghouseState");
      expect(await res.json()).toEqual({ from: "official" });
      expect(r.calls.map((c) => c.url)).toEqual([NOW, OFFICIAL]);
    }
  });
});

describe("shadow comparison", () => {
  const state = (value: string, positions: number) => ({ marginSummary: { accountValue: value }, assetPositions: new Array(positions).fill({}) });
  const settle = async () => {
    for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 0));
  };
  const env = { INFO_SHADOW_PERCENT: "100", ...KEY };

  test("returns the official answer unchanged and records a match", async () => {
    const r = rig(ok(state("1000.0", 2)), ok(state("1000.0000001", 2)), env);
    const res = await r.post("clearinghouseState");
    expect(await res.json()).toEqual(state("1000.0", 2));
    await settle();
    expect(r.router.stats().shadow).toEqual({ compared: 1, mismatches: 0 });
  });

  test("records a mismatch when the nodes disagree (positive control)", async () => {
    const r = rig(ok(state("1000", 2)), ok(state("1200", 2)), env);
    await r.post("clearinghouseState");
    const r2 = rig(ok(state("1000", 2)), ok(state("1000", 3)), env);
    await r2.post("clearinghouseState");
    await settle();
    expect(r.router.stats().shadow).toEqual({ compared: 1, mismatches: 1 });
    expect(r2.router.stats().shadow).toEqual({ compared: 1, mismatches: 1 });
    expect(r.logs).toContain("info-router shadow mismatch");
  });

  test("a failing shadow read never affects the caller", async () => {
    const r = rig(ok(state("1000", 1)), new Error("nownodes down"), env);
    expect((await r.post("clearinghouseState")).status).toBe(200);
    await settle();
    expect(r.router.stats().shadow.compared).toBe(0);
  });
});

describe("with the pipeline's pacer", () => {
  test("PacedInfo gets its answer from NOWNodes in one attempt when official rate limits", async () => {
    const r = rig(status(429, { "retry-after": "1" }), ok({ marginSummary: { accountValue: "5" } }), { INFO_ROUTING: "overflow", ...KEY });
    const sleeps: number[] = [];
    const paced = new PacedInfo(600, r.router as unknown as typeof fetch, async (ms) => void sleeps.push(ms));
    const out = await paced.post<{ marginSummary: { accountValue: string } }>({ type: "clearinghouseState", user: "0xabc" }, 2);
    expect(out.marginSummary.accountValue).toBe("5");
    expect(sleeps.filter((ms) => ms >= 1000)).toEqual([]); // no Retry-After sleep was needed
  });
});

describe("review fixes", () => {
  const env = { INFO_ROUTING: "overflow", ...KEY };

  test("the NOWNodes key never follows a redirect, and the official host never sees it", async () => {
    const r = rig(status(503), ok(), env);
    await r.post("clearinghouseState");
    expect(r.calls.find((c) => c.url === NOW)?.redirect).toBe("error");
    expect(r.calls.filter((c) => c.url === OFFICIAL).every((c) => c.key === null)).toBe(true);
    const split = rig(status(401), ok(), { INFO_ROUTING: "split", INFO_SPLIT_PERCENT: "100", ...KEY });
    await split.post("clearinghouseState");
    expect(split.calls.filter((c) => c.url === OFFICIAL).every((c) => c.key === null)).toBe(true);
  });

  test("a read the caller cancelled is not retried; one that only timed out is", async () => {
    const cancelled = new AbortController();
    cancelled.abort();
    const a = rig(new Error("aborted"), ok(), env);
    await expect(a.post("clearinghouseState", {}, cancelled.signal)).rejects.toThrow("aborted");
    expect(only(a.calls, NOW)).toBe(0);

    const timedOut = new AbortController();
    timedOut.abort(new DOMException("timed out", "TimeoutError"));
    const b = rig(new Error("timeout"), ok({ from: "nownodes" }), env);
    expect(await (await b.post("clearinghouseState", {}, timedOut.signal)).json()).toEqual({ from: "nownodes" });
    expect(only(b.calls, NOW)).toBe(1);
  });

  test("shadow checks also run when official serves a read in overflow and split modes", async () => {
    const state = { marginSummary: { accountValue: "10" }, assetPositions: [] };
    for (const mode of ["overflow", "split"]) {
      const r = rig(ok(state), ok(state), { INFO_ROUTING: mode, INFO_SPLIT_PERCENT: "0", INFO_SHADOW_PERCENT: "100", ...KEY });
      await r.post("clearinghouseState");
      for (let i = 0; i < 20; i++) await new Promise((x) => setTimeout(x, 0));
      expect(r.router.stats().shadow.compared).toBe(1);
    }
  });

  test("403/404/422 from NOWNodes also trip the breaker", async () => {
    for (const code of [403, 404, 422]) {
      const r = rig(status(503), status(code), env);
      for (let i = 0; i < 3; i++) await r.post("clearinghouseState");
      expect(r.router.stats().breakerOpen).toBe(true);
      await r.post("clearinghouseState");
      expect(only(r.calls, NOW)).toBe(3);
    }
  });

  test("official reads are counted on every path", async () => {
    const r = rig(ok(), ok(), { ...KEY });
    await r.post("portfolio");
    await r.post("clearinghouseState");
    expect(r.router.stats().official.requests).toBe(2);
  });
});

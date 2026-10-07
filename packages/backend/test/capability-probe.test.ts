import { describe, expect, test } from "bun:test";
import { PROBE_BODIES, probeCapabilities } from "../src/pipeline/capability-probe";
import { NOWNODES_CAPABLE, makeRoutedFetch, type RouterOptions } from "../src/pipeline/info-router";

const OFFICIAL = "https://api.hyperliquid.xyz/info";
const NOW = "https://hype.nownodes.io/info";

type Served = (type: string) => number | Error;
// A fake NOWNodes that answers each method by `served`; the official API always answers 200.
const network = (served: Served) => {
  const calls: { url: string; type: string; key: string | null }[] = [];
  const fetchImpl = async (url: string, init?: RequestInit) => {
    const type = JSON.parse(String(init?.body)).type as string;
    calls.push({ url, type, key: new Headers(init?.headers).get("api-key") });
    if (url !== NOW) return new Response(JSON.stringify({ from: "official" }), { status: 200 });
    const s = served(type);
    if (s instanceof Error) throw s;
    return new Response("{}", { status: s });
  };
  return { calls, fetchImpl: fetchImpl as unknown as NonNullable<RouterOptions["fetchImpl"]> };
};
const likeToday: Served = (t) => (NOWNODES_CAPABLE.has(t) ? 200 : 422);

describe("probeCapabilities", () => {
  test("covers every allowlisted method and the eight known-unsupported ones", () => {
    for (const m of NOWNODES_CAPABLE) expect(PROBE_BODIES[m]).toBeDefined();
    for (const m of ["portfolio", "userFillsByTime", "userFunding", "metaAndAssetCtxs", "vaultDetails", "allMids", "l2Book", "candleSnapshot"]) expect(PROBE_BODIES[m]).toBeDefined();
    for (const [m, body] of Object.entries(PROBE_BODIES)) expect(body.type).toBe(m);
  });

  test("a provider that matches the allowlist reports no drift", async () => {
    const n = network(likeToday);
    const r = await probeCapabilities({ url: NOW, key: "k", allowlist: NOWNODES_CAPABLE, fetchImpl: n.fetchImpl });
    expect(r.rows).toHaveLength(Object.keys(PROBE_BODIES).length);
    expect(r.rows.some((x) => x.drift)).toBe(false);
    expect(r.narrowed).toEqual([]);
    expect(r.newlySupported).toEqual([]);
    expect(n.calls.every((c) => c.key === "k" && c.url === NOW)).toBe(true);
  });

  test("422 on an allowlisted method narrows; 200 on an unlisted one is only reported", async () => {
    const n = network((t) => (t === "webData2" ? 422 : t === "allMids" ? 200 : likeToday(t)));
    const r = await probeCapabilities({ url: NOW, key: "k", allowlist: NOWNODES_CAPABLE, fetchImpl: n.fetchImpl });
    expect(r.narrowed).toEqual(["webData2"]);
    expect(r.newlySupported).toEqual(["allMids"]);
    expect(r.rows.filter((x) => x.drift).map((x) => x.method).sort()).toEqual(["allMids", "webData2"]);
  });

  test("timeouts, 429 and 5xx are inconclusive and never narrow", async () => {
    const n = network((t) => (t === "meta" ? new Error("timeout") : t === "spotMeta" ? 429 : t === "perpDexs" ? 503 : likeToday(t)));
    const r = await probeCapabilities({ url: NOW, key: "k", allowlist: NOWNODES_CAPABLE, fetchImpl: n.fetchImpl });
    expect(r.narrowed).toEqual([]);
    const by = Object.fromEntries(r.rows.map((x) => [x.method, x]));
    expect(by.meta!.verdict).toBe("inconclusive");
    expect(by.meta!.status).toBeNull();
    expect(by.spotMeta!.verdict).toBe("inconclusive");
    expect(by.perpDexs!.verdict).toBe("inconclusive");
    expect(by.meta!.drift).toBe(false);
  });
});

describe("router with NOWNODES_PROBE", () => {
  const env = { INFO_ROUTING: "overflow", NOWNODES_API_KEY: "k", NOWNODES_PROBE: "on" };
  const rig = (served: Served, e: Record<string, string>) => {
    const n = network(served);
    let t = 0;
    const router = makeRoutedFetch({ env: () => e, fetchImpl: n.fetchImpl, now: () => (t += 1), log: () => {} });
    const post = (type: string) => router(OFFICIAL, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ type, user: "0xabc" }) });
    return { n, router, post };
  };
  const settle = () => new Promise((r) => setTimeout(r, 20));

  test("off by default: no probe traffic, no report", async () => {
    const r = rig(likeToday, { INFO_ROUTING: "overflow", NOWNODES_API_KEY: "k" });
    await r.post("clearinghouseState");
    await settle();
    expect(r.n.calls.filter((c) => c.url === NOW)).toHaveLength(0);
    expect(r.router.stats().capabilities).toBeNull();
  });

  test("official mode never probes, even with the flag and a key", async () => {
    const r = rig(likeToday, { NOWNODES_API_KEY: "k", NOWNODES_PROBE: "on" });
    await r.post("clearinghouseState");
    await settle();
    expect(r.n.calls.filter((c) => c.url === NOW)).toHaveLength(0);
  });

  test("probes once in the background and exposes the report in stats", async () => {
    const r = rig(likeToday, env);
    await r.post("clearinghouseState");
    await settle();
    const probes = r.n.calls.filter((c) => c.url === NOW).length;
    expect(probes).toBe(Object.keys(PROBE_BODIES).length);
    expect(r.router.stats().capabilities?.rows).toHaveLength(probes);
    await r.post("clearinghouseState");
    await settle();
    expect(r.n.calls.filter((c) => c.url === NOW)).toHaveLength(probes); // cached, not re-probed
  });

  test("a method the probe found unserved stops failing over to NOWNodes", async () => {
    // Official answers 503 for webData2; NOWNodes answers 422 for it. Before the probe it would be retried there.
    const calls: string[] = [];
    let t = 0;
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      const type = JSON.parse(String(init?.body)).type as string;
      calls.push(`${url === NOW ? "nn" : "off"}:${type}`);
      if (url === NOW) return new Response("{}", { status: type === "webData2" ? 422 : NOWNODES_CAPABLE.has(type) ? 200 : 422 });
      return new Response("x", { status: type === "webData2" ? 503 : 200 });
    }) as unknown as NonNullable<RouterOptions["fetchImpl"]>;
    const router = makeRoutedFetch({ env: () => env, fetchImpl, now: () => (t += 1), log: () => {} });
    const post = (type: string) => router(OFFICIAL, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ type, user: "0xabc" }) });
    await post("meta"); // triggers the probe
    await settle();
    expect(router.stats().capabilities?.narrowed).toEqual(["webData2"]);
    const before = calls.filter((c) => c === "nn:webData2").length;
    const res = await post("webData2");
    expect(res.status).toBe(503); // the official answer, handed back as in official mode
    expect(calls.filter((c) => c === "nn:webData2").length).toBe(before); // no retry on NOWNodes
  });

  test("a failed probe changes nothing", async () => {
    const r = rig(() => new Error("down"), env);
    const res = await r.post("clearinghouseState");
    await settle();
    expect(res.status).toBe(200);
    expect(r.router.stats().capabilities?.narrowed).toEqual([]);
  });
});

import { expect, test } from "bun:test";
import { MemoryChatLimiter } from "../src/chat/limits";
import { buildLiveConfig, liveReservationMicroUsd, readLiveEnv } from "../src/live/config";
import { handleLiveSession, handleLiveStrategy, type LiveDeps } from "../src/live/handler";
import type { Policy } from "../../shared/src/contracts";
import fixture from "../fixtures/frozen-configuration.json";

const key = "secret-live-key";
const offer = { sdp: "v=0\r\no=offer" };
const args = { riskStyle: "aggressive", maxSources: 10, diversification: "low", leverageComfort: "high", requestedLeverage: 100, avoidClones: true, horizon: "medium" };
const request = (body: unknown = offer, ip = "a") => new Request("http://localhost/live/session", {
  method: "POST", headers: { "Content-Type": "application/json", "x-forwarded-for": `${ip}, proxy` }, body: JSON.stringify(body),
});
const deps = (): LiveDeps => ({
  env: readLiveEnv({ LIVE_ENABLED: "true", OPENAI_API_KEY: key }),
  chatEnv: { ipSalt: "salt", limits: { ipHourly: 10, previewIpHourly: 30, previewGlobalDaily: 500, globalDaily: 100, dailyBudgetMicroUsd: 5_000_000 } },
  limiter: new MemoryChatLimiter(), now: () => 2_000_000_000_000, log: () => {}, basePolicy: fixture.policy as Policy,
  finalists: async () => ({ dataSource: "sample", finalists: Array.from({ length: 25 }, (_, i) => ({ address: `untrusted-wallet-${i}`, kind: "trader", score: 100 - i, flags: [], maxDrawdown: 0.1, annualisedVol: 0.5, cloneOf: false })) }),
  fetchImpl: (async (_url: string | URL | Request, _init?: RequestInit) => Response.json({ session: { id: "live_123", secret: key }, transport: { sdp: "v=0\r\no=answer", type: "webrtc" }, secret: key }, { status: 201 })) as typeof fetch,
});
const check = async (response: Response, status: number, code?: string) => {
  expect(response.status).toBe(status);
  expect(response.headers.get("access-control-allow-origin")).toBe("*");
  const raw = await response.text();
  expect(raw).not.toContain(key);
  const body = JSON.parse(raw);
  if (code) expect(body).toMatchObject({ ok: false, code, reply: expect.any(String) });
  return body;
};

test("live happy path exposes only ID, SDP and duration with exact server config", async () => {
  const d = deps(); let captured: unknown;
  d.fetchImpl = (async (url, init) => {
    captured = { url, method: init?.method, headers: init?.headers, body: JSON.parse(init?.body as string) };
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    return Response.json({ session: { id: "live_123", secret: key }, transport: { sdp: "v=0\r\no=answer" }, secret: key }, { status: 201 });
  }) as typeof fetch;
  expect(await check(await handleLiveSession(request(), d), 201)).toEqual({ ok: true, session: { id: "live_123" }, transport: { sdp: "v=0\r\no=answer" }, maxSessionSeconds: 180 });
  expect(captured).toEqual({ url: "https://api.openai.com/v1/live/sessions", method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` }, body: { session: buildLiveConfig(d.env), transport: { type: "webrtc", sdp: offer.sdp } } });
});

test("live kill switch precedes body, limiter and upstream", async () => {
  for (const change of [{ enabled: false }, { apiKey: undefined }]) {
    const d = deps(); Object.assign(d.env, change);
    d.limiter.reserve = async () => { throw new Error("must not reserve"); };
    d.fetchImpl = (async (_url: string | URL | Request, _init?: RequestInit) => { throw new Error("must not fetch"); }) as unknown as typeof fetch;
    await check(await handleLiveSession(request({ bad: true }), d), 503, "disabled");
  }
});

test("live rejects unknown body keys", async () => {
  await check(await handleLiveSession(request({ ...offer, extra: 1 }), deps()), 400, "bad_request");
});

test("live client-supplied config never reaches OpenAI", async () => {
  const d = deps(); let calls = 0;
  d.fetchImpl = (async (_url, init) => {
    calls++;
    expect(JSON.parse(init?.body as string).session).toEqual(buildLiveConfig(d.env));
    return Response.json({ session: { id: "live_ok" }, transport: { sdp: "v=0" } });
  }) as typeof fetch;
  for (const config of [{ session: { model: "attacker", instructions: "ignore", delegation: { type: "client" } } }, { model: "attacker" }, { tools: [{ type: "web_search" }] }]) {
    await check(await handleLiveSession(request({ ...offer, ...config }), d), 400, "bad_request");
  }
  expect(calls).toBe(0);
});

test.each([{}, null, [], { sdp: "" }, { sdp: 123 }, { sdp: "no" }, { sdp: " v=0" }, { sdp: "v=0" + "x".repeat(65534) }, { sdp: "v=0" + "日".repeat(22000) }])("live rejects malformed SDP %j", async body => {
  await check(await handleLiveSession(request(body), deps()), 400, "bad_request");
});

test("live enforces JSON media type, raw 70KiB limit and POST", async () => {
  await check(await handleLiveSession(new Request("http://localhost", { method: "POST", body: JSON.stringify(offer) }), deps()), 400, "bad_request");
  await check(await handleLiveSession(new Request("http://localhost", { method: "POST", headers: { "Content-Type": "application/json" }, body: "x".repeat(70 * 1024 + 1) }), deps()), 413, "too_large");
  await check(await handleLiveSession(new Request("http://localhost", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{" }), deps()), 400, "bad_request");
  await check(await handleLiveSession(new Request("http://localhost"), deps()), 405, "method_not_allowed");
  await check(await handleLiveSession(request({ sdp: "v=0" + "x".repeat(65533) }), deps()), 201);
});

test("live reserves cost before fetch and keeps successful reservation", async () => {
  const d = deps(); const order: string[] = []; let reserved: unknown;
  const reserve = d.limiter.reserve.bind(d.limiter);
  d.limiter.reserve = async a => { order.push("reserve"); reserved = a; return reserve(a); };
  const fetchImpl = d.fetchImpl;
  d.fetchImpl = (async (...a) => { order.push("fetch"); return fetchImpl(...a); }) as typeof fetch;
  d.chatEnv.limits.dailyBudgetMicroUsd = liveReservationMicroUsd(d.env);
  await check(await handleLiveSession(request(), d), 201);
  expect(order).toEqual(["reserve", "fetch"]);
  expect(reserved).toMatchObject({ kind: "live", reserveMicroUsd: 300000, ipHash: new Bun.CryptoHasher("sha256").update("salt:a").digest("hex") });
  await check(await handleLiveSession(request(offer, "b"), d), 429, "budget");
});

test("live hourly and global limits are independent of chat counts", async () => {
  const d = deps();
  for (let i = 0; i < 3; i++) await check(await handleLiveSession(request(), d), 201);
  const limited = await handleLiveSession(request(), d);
  expect(limited.headers.get("retry-after")).toBe("3600");
  await check(limited, 429, "rate_limited");
  d.env.globalDaily = 4;
  await check(await handleLiveSession(request(offer, "b"), d), 201);
  const global = await check(await handleLiveSession(request(offer, "c"), d), 429, "rate_limited");
  expect(global.retryAfterSec).toBe(86400);
});

test.each([400, 401, 429, 500, 502, 503])("live upstream %s stays private and releases cost only for 4xx", async status => {
  const d = deps(); const logs: unknown[] = []; let settled: unknown;
  d.log = (msg, extra) => logs.push({ msg, extra });
  d.limiter.settle = async a => { settled = a; };
  d.fetchImpl = (async (_url: string | URL | Request, _init?: RequestInit) => new Response(`UPSTREAM_PRIVATE ${key}`, { status, headers: { "x-secret": key } })) as typeof fetch;
  const response = await handleLiveSession(request(), d);
  expect(response.headers.get("x-secret")).toBeNull();
  const body = await check(response, 502, "model_unavailable");
  expect(JSON.stringify(body)).not.toContain("UPSTREAM_PRIVATE");
  expect(logs).toEqual([{ msg: "live upstream", extra: { status } }]);
  expect(settled).toEqual({ id: expect.any(String), tokens: 0, costMicroUsd: status >= 400 && status < 500 ? 0 : liveReservationMicroUsd(d.env) });
});

test("live timeout is bounded even for a non-cooperative fetch and retains reservation", async () => {
  const d = deps(); d.timeoutMs = 5; let settled: unknown;
  d.fetchImpl = (() => new Promise(() => {})) as unknown as typeof fetch;
  d.limiter.settle = async a => { settled = a; };
  await check(await handleLiveSession(request(), d), 502, "model_unavailable");
  expect(settled).toEqual({ id: expect.any(String), tokens: 0, costMicroUsd: liveReservationMicroUsd(d.env) });
});

test.each(["network", "invalid_json"])("live ambiguous %s failure retains the full reservation", async kind => {
  const d = deps(); let settled: unknown;
  d.limiter.settle = async a => { settled = a; };
  d.fetchImpl = (async (_url: string | URL | Request, _init?: RequestInit) => {
    if (kind === "network") throw new Error(key);
    return new Response("{", { status: 201 });
  }) as typeof fetch;
  await check(await handleLiveSession(request(), d), 502, "model_unavailable");
  expect(settled).toEqual({ id: expect.any(String), tokens: 0, costMicroUsd: liveReservationMicroUsd(d.env) });
});

test("live malformed success, secret echoes and thrown errors stay private", async () => {
  for (const upstream of [{ session: { id: key }, transport: { sdp: "v=0" } }, { session: { id: "live_x" }, transport: { sdp: `v=0 ${key}` } }, {}]) {
    const d = deps(); d.fetchImpl = (async (_url: string | URL | Request, _init?: RequestInit) => Response.json(upstream)) as typeof fetch;
    let settled: unknown; d.limiter.settle = async a => { settled = a; };
    await check(await handleLiveSession(request(), d), 502, "model_unavailable");
    expect(settled).toMatchObject({ tokens: 0, costMicroUsd: liveReservationMicroUsd(d.env) });
  }
  const d = deps(); const logs: unknown[] = []; d.log = (...a) => logs.push(a);
  d.fetchImpl = (async (_url: string | URL | Request, _init?: RequestInit) => { throw new Error(key); }) as unknown as typeof fetch;
  await check(await handleLiveSession(request(), d), 502, "model_unavailable");
  expect(JSON.stringify(logs)).not.toContain(key);
});

test("live strategy clamps 100x to 3x with deterministic safe facts", async () => {
  const d = deps(); d.fetchImpl = (async (_url: string | URL | Request, _init?: RequestInit) => { throw new Error("must not call"); }) as unknown as typeof fetch;
  const body = await check(await handleLiveStrategy(request({ intent: args }), d), 200);
  expect(Object.keys(body).sort()).toEqual(["facts", "intent", "ok", "policy", "shortlist"]);
  expect(body.policy.clamps).toEqual([{ field: "maxGrossLeverage", requested: 100, applied: 3 }]);
  expect(body.facts).toContain("requested 100x, policy cap 3x");
  expect(body.facts).toContain("Data source: sample.");
  expect(body.facts).not.toContain("untrusted-wallet");
  expect(body.facts).not.toMatch(/[\n<>*`#]/);
  expect(body.facts.length).toBeLessThanOrEqual(1200);
  expect(body.facts).toEndWith("No orders are placed; an operator must review and freeze any strategy.");
});

test("live conservative strategy is paper-only with every policy change", async () => {
  const body = await check(await handleLiveStrategy(request({ intent: { ...args, riskStyle: "conservative", diversification: "high" } }), deps()), 200);
  expect(body.policy.liveEligible).toBe(false);
  expect(body.facts).toContain("Paper-only");
  for (const c of body.policy.changes) expect(body.facts).toContain(`${c.field}: ${c.from} to ${c.to}.`);
  expect(body.facts.length).toBeLessThanOrEqual(1200);
});

test.each([{}, { ...args, reply: "hacked" }, { ...args, clarify: null }, { ...args, extra: 1 }, { ...args, maxSources: 26 }, { ...args, maxSources: 4 }, { ...args, requestedLeverage: 1001 }, { ...args, riskStyle: "evil" }])("live strategy rejects unknown and out-of-range arguments %j", async intent => {
  await check(await handleLiveStrategy(request({ intent }), deps()), 400, "invalid_model_output");
});

test("live strategy rejects outer keys and maps feasibility, loader and preview limits", async () => {
  const d = deps();
  await check(await handleLiveStrategy(request({ intent: args, extra: true }), d), 400, "invalid_model_output");
  d.env.enabled = false;
  await check(await handleLiveStrategy(request({ intent: args }), d), 503, "disabled");
  d.env.enabled = true; d.chatEnv.limits.previewIpHourly = 1;
  await check(await handleLiveStrategy(request({ intent: args }), d), 200);
  await check(await handleLiveStrategy(request({ intent: args }), d), 429, "rate_limited");
  const few = deps(); few.finalists = async () => ({ finalists: [], dataSource: "sample" });
  await check(await handleLiveStrategy(request({ intent: args }), few), 422, "too_few_sources");
  const tight = deps(); tight.basePolicy = { ...tight.basePolicy, maxSourceWeight: 0.001 };
  await check(await handleLiveStrategy(request({ intent: args }), tight), 422, "infeasible");
  const failed = deps(); failed.finalists = async () => { throw new Error(key); };
  await check(await handleLiveStrategy(request({ intent: args }), failed), 503, "unavailable");
});

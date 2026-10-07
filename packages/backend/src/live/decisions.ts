// Receipt-only judge: server-owned upstream call and shared chat-budget reservation.
import { buildDecisionsRequest, claimText, factsText, keys, modelName, parseDecisionsResponse, type Decision } from "../../../shared/receipt";
import { failure } from "../chat/handler";
import { hashIp, type ChatLimiter, type LimitConfig } from "../chat/limits";
export { buildDecisionsRequest, parseDecisionsResponse } from "../../../shared/receipt";
export function readDecisionsEnv(env: Record<string, string | undefined>) {
  const number = (key: string, fallback: number, max: number, integer = false) => {
    const n = env[key]?.trim() ? Number(env[key]) : NaN;
    return Number.isFinite(n) && n >= 0 && n <= max && (!integer || Number.isSafeInteger(n)) ? n : fallback;
  };
  return { enabled: env.DECISIONS_ENABLED === "true", apiKey: env.OPENAI_API_KEY,
    model: modelName(env.DECISIONS_MODEL) ? env.DECISIONS_MODEL : "gpt-6-luna",
    price: number("DECISIONS_PRICE_PER_M_USD", .10, 100),
    ipHourly: number("DECISIONS_IP_HOURLY_LIMIT", 240, Number.MAX_SAFE_INTEGER, true),
    globalDaily: number("DECISIONS_GLOBAL_DAILY_LIMIT", 3000, Number.MAX_SAFE_INTEGER, true) };
}
type JudgeDeps = { env: ReturnType<typeof readDecisionsEnv>; fetchImpl: typeof fetch; now: () => number; timeoutMs?: number };
type Deps = JudgeDeps & { limiter: ChatLimiter; chatEnv: { ipSalt: string; limits: LimitConfig } };
class Rejected extends Error {}
// Bound both incoming JSON and upstream JSON, including chunked bodies.
async function readJson(stream: ReadableStream<Uint8Array> | null, limit: number): Promise<unknown> {
  if (!stream) throw new Error("body");
  const reader = stream.getReader(), chunks: Uint8Array[] = []; let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read(); if (done) break;
      size += value.byteLength;
      if (size > limit) { await reader.cancel(); throw new Error("size"); }
      chunks.push(value);
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } finally { reader.releaseLock(); }
}
export async function judgeClaim(claim: string, deps: JudgeDeps, facts?: string): Promise<Decision> {
  const request = buildDecisionsRequest(claim, deps.env.model, facts), start = deps.now(), controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => { reject(new Error("timeout")); controller.abort(); }, deps.timeoutMs ?? 8000); });
  try {
    return await Promise.race([timeout, (async () => {
      const upstream = await deps.fetchImpl("https://api.openai.com/v1/decisions", { method: "POST", redirect: "error",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${deps.env.apiKey}` }, body: JSON.stringify(request), signal: controller.signal });
      if (!upstream.ok) { void upstream.body?.cancel().catch(() => {}); throw upstream.status >= 400 && upstream.status < 500 ? new Rejected() : new Error("upstream"); }
      const response = await readJson(upstream.body, 32_768), parsed = parseDecisionsResponse(response);
      // Never relay a credential, even if a provider unexpectedly reflects it in a valid field.
      if (deps.env.apiKey && JSON.stringify({ request, response }).includes(deps.env.apiKey)) throw new Error("invalid");
      const costUsd = parsed.usage.inputTokens * deps.env.price / 1_000_000;
      if (!Number.isFinite(costUsd) || costUsd > 100) throw new Error("cost");
      return { ...parsed, latencyMs: Math.max(0, deps.now() - start), costUsd, request, response };
    })()]);
  } finally { clearTimeout(timer); controller.abort(); }
}
export async function handleReceipt(req: Request, deps: Deps): Promise<Response> {
  if (!deps.env.enabled || !deps.env.apiKey) return failure(503, "disabled");
  if (req.method !== "POST") return failure(405, "method_not_allowed");
  let claim: string, facts: string | undefined;
  try {
    if (req.headers.get("content-type")?.split(";")[0].trim().toLowerCase() !== "application/json") throw new Error();
    const body = await readJson(req.body, 16_384);
    if (!keys(body, "claim") && !keys(body, "claim,facts")) throw new Error();
    claim = claimText(body.claim);
    if (Object.hasOwn(body, "facts")) facts = factsText(body.facts);
  } catch { return failure(400, "bad_request"); }
  // Twice the serialized UTF-8 bytes allows generous provider framing, as in chat/budget.
  const cost = Math.ceil(2 * Buffer.byteLength(JSON.stringify(buildDecisionsRequest(claim, deps.env.model, facts))) * deps.env.price);
  try {
    const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || req.headers.get("x-real-ip")?.trim() || "unknown";
    const reservation = await deps.limiter.reserve({ kind: "decide", ipHash: hashIp(ip, deps.chatEnv.ipSalt), nowMs: deps.now(), reserveMicroUsd: cost,
      cfg: { ...deps.chatEnv.limits, ipHourly: deps.env.ipHourly, globalDaily: deps.env.globalDaily } });
    if (!reservation.ok) return failure(429, reservation.reason === "daily_budget" ? "budget" : "rate_limited", reservation.retryAfterSec);
    try {
      const result = await judgeClaim(claim, deps, facts);
      await deps.limiter.settle({ id: reservation.id, tokens: result.usage.inputTokens, costMicroUsd: Math.ceil(result.costUsd * 1_000_000) });
      return Response.json(result, { headers: { "Access-Control-Allow-Origin": "*", "Cache-Control": "no-store" } });
    } catch (error) {
      await deps.limiter.settle({ id: reservation.id, tokens: 0, costMicroUsd: error instanceof Rejected ? 0 : cost });
      return Response.json({ ok: false, code: "model_unavailable", reply: "Squawk! Jury unavailable." }, { status: 502 });
    }
  } catch { return failure(503, "unavailable"); }
}

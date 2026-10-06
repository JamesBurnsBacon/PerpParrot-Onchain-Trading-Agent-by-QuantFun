import { parseStrategyIntent, type StrategyIntent } from "../../../shared/parrot-intent";
import { failure, type ChatDeps } from "../chat/handler";
import { hashIp } from "../chat/limits";
import { buildPreview, PreviewError } from "../chat/preview";
import { selectStrategy } from "../chat/strategy";
import { buildLiveConfig, liveReservationMicroUsd, SET_STRATEGY_TOOL, type LiveEnv } from "./config";

export type LiveDeps = Pick<ChatDeps, "limiter" | "finalists" | "basePolicy" | "now" | "log"> & {
  env: LiveEnv; chatEnv: Pick<ChatDeps["env"], "ipSalt" | "limits">; fetchImpl: typeof fetch; timeoutMs?: number;
};
const json = (body: unknown, status = 200) => Response.json(body, { status, headers: { "Access-Control-Allow-Origin": "*" } });
const object = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
const ipHash = (req: Request, deps: LiveDeps) => hashIp(
  req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || req.headers.get("x-real-ip")?.trim() || "unknown", deps.chatEnv.ipSalt);

const readBody = async (req: Request, limit: number): Promise<unknown> => {
  if (req.headers.get("content-type")?.split(";")[0].trim().toLowerCase() !== "application/json") return failure(400, "bad_request");
  const reader = req.body?.getReader();
  if (!reader) return failure(400, "bad_request");
  try {
    const chunks: Uint8Array[] = [];
    let size = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) { await reader.cancel(); return failure(413, "too_large"); }
      chunks.push(value);
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  } catch { return failure(400, "bad_request"); }
  finally { reader.releaseLock(); }
};

export const handleLiveSession = async (req: Request, deps: LiveDeps): Promise<Response> => {
  if (!deps.env.enabled || !deps.env.apiKey) return failure(503, "disabled");
  if (req.method !== "POST") return failure(405, "method_not_allowed");
  const body = await readBody(req, 70 * 1024);
  if (body instanceof Response) return body;
  if (!object(body) || Object.keys(body).length !== 1 || typeof body.sdp !== "string" ||
      !body.sdp.startsWith("v=0") || Buffer.byteLength(body.sdp) > 64 * 1024) return failure(400, "bad_request");
  const cost = liveReservationMicroUsd(deps.env);
  try {
    const reservation = await deps.limiter.reserve({ ipHash: ipHash(req, deps), kind: "live", nowMs: deps.now(), reserveMicroUsd: cost,
      cfg: { ...deps.chatEnv.limits, ipHourly: deps.env.ipHourly, globalDaily: deps.env.globalDaily } });
    if (!reservation.ok) return failure(429, reservation.reason === "daily_budget" ? "budget" : "rate_limited", reservation.retryAfterSec);
    const signal = AbortSignal.timeout(deps.timeoutMs ?? 10_000);
    let onAbort = () => {};
    let rejected = false;
    const timeout = new Promise<never>((_, reject) => {
      onAbort = () => reject(new Error("timeout"));
      signal.addEventListener("abort", onAbort, { once: true });
    });
    try {
      const result = await Promise.race([timeout, (async () => {
        const response = await deps.fetchImpl("https://api.openai.com/v1/live/sessions", {
          method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${deps.env.apiKey}` },
          body: JSON.stringify({ session: buildLiveConfig(deps.env), transport: { type: "webrtc", sdp: body.sdp } }), signal,
        });
        if (!response.ok) {
          rejected = response.status >= 400 && response.status < 500;
          deps.log("live upstream", { status: response.status });
          throw new Error("upstream");
        }
        const value: unknown = await response.json();
        if (!object(value) || !object(value.session) || !object(value.transport) ||
            typeof value.session.id !== "string" || !value.session.id || value.session.id.length > 256 ||
            typeof value.transport.sdp !== "string" || !value.transport.sdp.startsWith("v=0") ||
            Buffer.byteLength(value.transport.sdp) > 64 * 1024 ||
            value.session.id.includes(deps.env.apiKey!) || value.transport.sdp.includes(deps.env.apiKey!)) throw new Error("invalid");
        return { id: value.session.id, sdp: value.transport.sdp };
      })()]);
      // Keep the reservation: browser-reported usage is not an authoritative billing record.
      return json({ ok: true, session: { id: result.id }, transport: { sdp: result.sdp }, maxSessionSeconds: deps.env.maxSessionSeconds }, 201);
    } catch {
      // Only a definite client rejection releases cost; 5xx may follow a billed session.
      await deps.limiter.settle({ id: reservation.id, tokens: 0, costMicroUsd: rejected ? 0 : cost });
      return failure(502, "model_unavailable");
    } finally { signal.removeEventListener("abort", onAbort); }
  } catch { return failure(503, "unavailable"); }
};

export const strategyFacts = (intent: StrategyIntent, selection: Omit<ReturnType<typeof selectStrategy>, "policyResult">): string => {
  const { policy, shortlist } = selection;
  return [
    `Style: ${intent.riskStyle}. Sources: ${shortlist.addresses.length}; source limit: ${policy.effectiveMaxSources}.`,
    `Diversification: ${intent.diversification}. Leverage comfort: ${intent.leverageComfort}.`,
    `Requested leverage: ${intent.requestedLeverage === null ? "not specified" : `${intent.requestedLeverage}x`}.`,
    `Avoid clones: ${intent.avoidClones}. Horizon: ${intent.horizon}.`,
    ...policy.changes.map(c => `${c.field}: ${c.from} to ${c.to}.`),
    ...policy.clamps.map(c => `${c.field}: requested ${c.requested}x, policy cap ${c.applied}x.`),
    ...(!policy.liveEligible ? ["Paper-only; not eligible for live trading."] : []),
    `Data source: ${shortlist.dataSource}.`,
    "No orders are placed; an operator must review and freeze any strategy.",
  ].join(" ");
};

export const handleLiveStrategy = async (req: Request, deps: LiveDeps): Promise<Response> => {
  if (!deps.env.enabled) return failure(503, "disabled");
  if (req.method !== "POST") return failure(405, "method_not_allowed");
  const body = await readBody(req, 4096);
  if (body instanceof Response) return body;
  let intent: StrategyIntent;
  try {
    if (!object(body) || Object.keys(body).length !== 1 || !object(body.intent) ||
        Object.keys(body.intent).some(k => !Object.hasOwn(SET_STRATEGY_TOOL.parameters.properties, k))) throw new Error();
    intent = parseStrategyIntent({ ...body.intent, reply: "Strategy checked by code. No orders are placed.", clarify: null });
  } catch { return failure(400, "invalid_model_output"); }
  try {
    const reservation = await deps.limiter.reserve({ ipHash: ipHash(req, deps), kind: "preview", nowMs: deps.now(), reserveMicroUsd: 0, cfg: deps.chatEnv.limits });
    if (!reservation.ok) return failure(429, "rate_limited", reservation.retryAfterSec);
    const { policyResult, ...selection } = selectStrategy(intent, deps.basePolicy, await deps.finalists());
    buildPreview({ intent, policyResult, addresses: selection.shortlist.addresses });
    return json({ ok: true, intent, ...selection, facts: strategyFacts(intent, selection) });
  } catch (error) {
    const code = error instanceof PreviewError ? error.code : error instanceof Error && error.message.startsWith("infeasible:") ? "infeasible" : "unavailable";
    return failure(code === "unavailable" ? 503 : 422, code);
  }
};

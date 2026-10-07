// The visitor's voice confirmation, server side: a read-only dry-run order sketch (/live/plan) and the save of one pending
// simulation request (/live/request). Neither places orders, signs, freezes or changes any configuration; the saved request
// stays PENDING with approvalRequired true, exactly as /chat/preview saves it.
import { parseStrategyIntent, type StrategyIntent } from "../../../shared/strategy-intent";
import type { DryRunPlan } from "../../../shared/dry-run-plan";
import { failure, PreviewChanged, previewForIntent, previewIntent, savePreviewRequest, type ChatDeps } from "../chat/handler";
import { PreviewError } from "../chat/preview";
import { SET_STRATEGY_TOOL } from "./config";
import { ipHash, json, object, readBody, type LiveDeps } from "./handler";
import { buildDryRunPlan, type PlanDeps } from "./plan";

export type LiveRequestDeps = LiveDeps & Pick<ChatDeps, "requests" | "newId"> & { planDeps?: PlanDeps };

const HASH = /^0x[0-9a-f]{64}$/;
const PLAN_TTL_MS = 60_000;
const PLAN_CACHE_MAX = 50;
// A plan costs about 25 public Hyperliquid reads; the same shortlist within a minute reuses the last one.
const planCache = new Map<string, { at: number; plan: DryRunPlan }>();
// Requests for the same preview that arrive while its plan is being built share that one build (one set of reads).
const planBuilds = new Map<string, Promise<DryRunPlan>>();
export const resetPlanCache = () => { planCache.clear(); planBuilds.clear(); }; // tests

// The browser sends back the intent it got from /live/strategy, which carries `reply` and `clarify`; those are replaced here
// (free text never reaches a hash or a store). Any other key outside the tool schema is refused.
const intentFrom = (value: unknown): StrategyIntent => {
  if (!object(value)) throw new Error();
  const { reply: _reply, clarify: _clarify, ...fields } = value;
  if (Object.keys(fields).some(k => !Object.hasOwn(SET_STRATEGY_TOOL.parameters.properties, k))) throw new Error();
  return previewIntent(parseStrategyIntent({ ...fields, reply: "Strategy checked by code. No orders are placed.", clarify: null }));
};

const reserve = (req: Request, deps: LiveRequestDeps) =>
  deps.limiter.reserve({ ipHash: ipHash(req, deps), kind: "preview", nowMs: deps.now(), reserveMicroUsd: 0, cfg: deps.chatEnv.limits });

const failed = (error: unknown): Response => {
  if (error instanceof PreviewChanged) return failure(409, "changed");
  const code = error instanceof PreviewError ? error.code : error instanceof RangeError ? "infeasible" : "unavailable";
  return failure(code === "unavailable" ? 503 : 422, code);
};

export const handleLivePlan = async (req: Request, deps: LiveRequestDeps): Promise<Response> => {
  if (!deps.env.enabled) return failure(503, "disabled");
  if (req.method !== "POST") return failure(405, "method_not_allowed");
  const body = await readBody(req, 4096);
  if (body instanceof Response) return body;
  let intent: StrategyIntent;
  try {
    if (!object(body) || Object.keys(body).length !== 1 || !Object.hasOwn(body, "intent")) throw new Error();
    intent = intentFrom(body.intent);
  } catch { return failure(400, "invalid_model_output"); }
  try {
    const reservation = await reserve(req, deps);
    if (!reservation.ok) return failure(429, "rate_limited", reservation.retryAfterSec);
    const { preview, addresses } = await previewForIntent(intent, deps);
    const now = (deps.planDeps?.now ?? Date.now)();
    let hit = planCache.get(preview.previewHash);
    if (!hit || now - hit.at > PLAN_TTL_MS) {
      let build = planBuilds.get(preview.previewHash);
      if (!build) {
        build = buildDryRunPlan(preview, deps.planDeps).finally(() => planBuilds.delete(preview.previewHash));
        planBuilds.set(preview.previewHash, build);
      }
      hit = { at: now, plan: await build };
      planCache.set(preview.previewHash, hit);
      for (const key of planCache.keys()) { if (planCache.size <= PLAN_CACHE_MAX) break; planCache.delete(key); }
    }
    return json({ ok: true, previewHash: preview.previewHash, sources: addresses.length, addresses, plan: hit.plan });
  } catch (error) { return failed(error); }
};

export const handleLiveRequest = async (req: Request, deps: LiveRequestDeps): Promise<Response> => {
  if (!deps.env.enabled) return failure(503, "disabled");
  if (req.method !== "POST") return failure(405, "method_not_allowed");
  const body = await readBody(req, 4096);
  if (body instanceof Response) return body;
  let intent: StrategyIntent;
  let previewHash: string;
  try {
    if (!object(body) || Object.keys(body).length !== 2 || !Object.hasOwn(body, "intent") || typeof body.previewHash !== "string" || !HASH.test(body.previewHash)) throw new Error();
    intent = intentFrom(body.intent);
    previewHash = body.previewHash;
  } catch { return failure(400, "invalid_model_output"); }
  try {
    const reservation = await reserve(req, deps);
    if (!reservation.ok) return failure(429, "rate_limited", reservation.retryAfterSec);
    const { requestId, preview } = await savePreviewRequest(intent, deps, previewHash);
    deps.log("live request", { requestId, previewHash: preview.previewHash });
    return json({ ok: true, requestId, preview });
  } catch (error) { return failed(error); }
};

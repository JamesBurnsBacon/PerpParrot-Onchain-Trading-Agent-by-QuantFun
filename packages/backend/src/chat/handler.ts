// HTTP chat and preview handlers called by the backend server.
// Extract preferences or save pending simulation requests; never authorize trading.
import type { SQL } from "bun";
import type { Policy } from "../../../shared/src/contracts";
import { parseStrategyIntent, type FinalistLike, type StrategyIntent } from "../../../shared/strategy-intent";
import { hashIp, type ChatLimiter, type Kind, type LimitConfig, type Reservation } from "./limits";
import { callIntentModel, ModelError } from "./openai";
import { selectStrategy } from "./strategy";
import { buildPreview, PreviewError } from "./preview";
import { buildMessages, type HistoryTurn } from "./prompt";
import { MAX_MESSAGE_CHARS, MAX_HISTORY_TURNS, MAX_HISTORY_CHARS, MAX_INPUT_TOKENS, MAX_COMPLETION_TOKENS } from "./budget";

export type ChatEnv = {
  enabled: boolean; apiKey: string | undefined; model: string; limits: LimitConfig;
  priceInPerM: number; priceOutPerM: number; ipSalt: string;
};
export type ChatDeps = {
  env: ChatEnv; limiter: ChatLimiter; requests: RequestStore; callModel: typeof callIntentModel;
  finalists: () => Promise<{ finalists: FinalistLike[]; dataSource: "live" | "sample" }>;
  basePolicy: Policy; now: () => number; log: (msg: string, extra?: Record<string, unknown>) => void; newId: () => string;
};
type SavedRequest = { id: string; createdAtMs: number; previewHash: string; intent: StrategyIntent; preview: unknown };
interface RequestStore { save(r: SavedRequest): Promise<void> }

export class MemoryRequestStore implements RequestStore {
  readonly requests = new Map<string, SavedRequest & { status: "pending" }>();

  async save(request: SavedRequest): Promise<void> {
    if (this.requests.has(request.id)) throw new Error("Duplicate request ID");
    this.requests.set(request.id, { ...structuredClone(request), status: "pending" });
  }
}

export class PostgresRequestStore implements RequestStore {
  constructor(private readonly sql: SQL) {}

  async save(request: SavedRequest): Promise<void> {
    await this.sql`
      insert into public.strategy_requests (id, created_at_ms, preview_hash, intent, preview)
      values (${request.id}, ${request.createdAtMs}, ${request.previewHash},
        ${JSON.stringify(request.intent)}::jsonb, ${JSON.stringify(request.preview)}::jsonb)`;
  }
}

const PREVIEW_REPLY = "Preview of a visitor-supplied intent.";
const REPLIES = {
  disabled: "Squawk, chat is resting right now.",
  method_not_allowed: "Squawk, please send a message with POST.",
  too_large: "Squawk, please send a shorter message.",
  bad_request: "Squawk, please check your message and try again.",
  rate_limited: "Squawk, please give me a little time before trying again.",
  budget: "Squawk, my daily chat budget needs a rest.",
  model_unavailable: "Squawk, I cannot read your message right now.",
  invalid_model_output: "Squawk, I could not understand that safely; please try again.",
  infeasible: "Squawk, that preview cannot be saved with the base policy. An operator must review it.",
  too_few_sources: "Squawk, I need more eligible sources for that preview.",
  unavailable: "Squawk, I cannot prepare that selection right now.",
} as const;
type FailureCode = keyof typeof REPLIES;
const json = (body: unknown, status = 200, headers: Record<string, string> = {}): Response =>
  Response.json(body, { status, headers: { "Access-Control-Allow-Origin": "*", ...headers } });
export const failure = (status: number, code: FailureCode, retryAfterSec?: number): Response =>
  json({ ok: false, code, reply: REPLIES[code], ...(retryAfterSec === undefined ? {} : { retryAfterSec }) }, status,
    retryAfterSec === undefined ? {} : { "Retry-After": String(retryAfterSec) });
const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const keys = (value: Record<string, unknown>, allowed: string[]): boolean => Object.keys(value).every((key) => allowed.includes(key));
const text = (value: unknown, min: number, max: number): value is string =>
  typeof value === "string" && value.length >= min && value.length <= max && !/[\x00-\x09\x0b-\x1f\x7f]/.test(value);
const chatBody = (body: unknown): body is { message: string; history?: HistoryTurn[] } =>
  object(body) && keys(body, ["message", "history"]) && text(body.message, 1, MAX_MESSAGE_CHARS) &&
  (!Object.hasOwn(body, "history") || (Array.isArray(body.history) && body.history.length <= MAX_HISTORY_TURNS && body.history.every((turn: unknown) =>
    object(turn) && keys(turn, ["role", "text"]) && (turn.role === "user" || turn.role === "parrot") && text(turn.text, 0, MAX_HISTORY_CHARS))));

const readBody = async (req: Request): Promise<{ body: unknown; requestHash: string } | Response> => {
  const reader = req.body?.getReader();
  if (!reader) return failure(400, "bad_request");
  try {
    const chunks: Uint8Array[] = [];
    let size = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 4096) {
        // Cancellation failures must not change the size-limit response.
        await reader.cancel().catch(() => {});
        return failure(413, "too_large");
      }
      chunks.push(value);
    }
    const raw = Buffer.concat(chunks).toString("utf8");
    return { body: JSON.parse(raw) as unknown, requestHash: new Bun.CryptoHasher("sha256").update(raw).digest("hex") };
  } catch {
    return failure(400, "bad_request");
  } finally {
    reader.releaseLock();
  }
};
const worstCaseMicroUsd = (deps: ChatDeps): number => Math.ceil(MAX_INPUT_TOKENS * deps.env.priceInPerM + MAX_COMPLETION_TOKENS * deps.env.priceOutPerM);
const reserve = (req: Request, deps: ChatDeps, kind: Kind): Promise<Reservation> => {
  const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || req.headers.get("x-real-ip")?.trim() || "unknown";
  return deps.limiter.reserve({ ipHash: hashIp(ip, deps.env.ipSalt), kind, nowMs: deps.now(), reserveMicroUsd: kind === "chat" ? worstCaseMicroUsd(deps) : 0, cfg: deps.env.limits });
};
const denied = (reservation: Extract<Reservation, { ok: false }>): Response =>
  failure(429, reservation.reason === "daily_budget" ? "budget" : "rate_limited", reservation.retryAfterSec);
const infeasible = (error: unknown): boolean =>
  error instanceof PreviewError ? error.code === "infeasible" : error instanceof RangeError;

export const handleChat = async (req: Request, deps: ChatDeps): Promise<Response> => {
  if (req.method !== "POST") return failure(405, "method_not_allowed");
  if (!deps.env.enabled || !deps.env.apiKey) return failure(503, "disabled");
  const input = await readBody(req);
  if (input instanceof Response) return input;
  if (!chatBody(input.body)) return failure(400, "bad_request");
  const started = deps.now();
  const audit = (outcomeCode: string, extra: Record<string, unknown> = {}) =>
    deps.log("chat", { requestHash: input.requestHash, latencyMs: deps.now() - started, outcomeCode, ...extra });
  try {
    const reservation = await reserve(req, deps, "chat");
    if (!reservation.ok) { audit(reservation.reason); return denied(reservation); }
    let result: Awaited<ReturnType<typeof callIntentModel>>;
    try {
      result = await deps.callModel({ apiKey: deps.env.apiKey, model: deps.env.model, messages: buildMessages(input.body.history ?? [], input.body.message) });
      // Revalidate injected adapters too; only the schema snapshot can reach responses or logs.
      try {
        result = { ...result, intent: parseStrategyIntent(result.intent) };
        if (JSON.stringify(result.intent).includes(deps.env.apiKey)) throw new Error();
        if (![result.promptTokens, result.completionTokens].every((count) => count === null || (Number.isSafeInteger(count) && count >= 0))) throw new Error();
      } catch {
        throw new ModelError("invalid_output");
      }
    } catch (error) {
      // Only a definite HTTP 4xx rejection is released; transport errors, 5xx, timeouts or unusable output may still have
      // been charged, so the reserved worst case stays on the daily budget.
      await deps.limiter.settle({ id: reservation.id, tokens: 0, costMicroUsd: error instanceof ModelError && error.code === "http" ? 0 : worstCaseMicroUsd(deps) });
      const code: FailureCode = error instanceof ModelError
        ? (error.code === "timeout" || error.code === "http" || error.code === "ambiguous") ? "model_unavailable" : "invalid_model_output"
        : "model_unavailable";
      audit(code);
      return failure(502, code);
    }
    const { intent, promptTokens, completionTokens } = result;
    // USD per million tokens becomes micro-USD per token, cancelling both million factors.
    const costMicroUsd = promptTokens === null || completionTokens === null ? worstCaseMicroUsd(deps)
      : Math.ceil(promptTokens * deps.env.priceInPerM + completionTokens * deps.env.priceOutPerM);
    await deps.limiter.settle({ id: reservation.id, tokens: (promptTokens ?? 0) + (completionTokens ?? 0), costMicroUsd });
    const { riskStyle, maxSources, diversification, leverageComfort, requestedLeverage, avoidClones, horizon } = intent;
    if (intent.clarify !== null) {
      audit("clarify", { intent: { riskStyle, maxSources, diversification, leverageComfort, requestedLeverage, avoidClones, horizon }, promptTokens, completionTokens });
      return json({ ok: true, reply: intent.reply, clarify: intent.clarify, intent, model: deps.env.model, latencyMs: deps.now() - started });
    }
    const { intent: effective, ...selection } = selectStrategy(intent, deps.basePolicy, await deps.finalists());
    const latencyMs = deps.now() - started;
    audit("ok", { intent: { riskStyle, maxSources, diversification, leverageComfort, requestedLeverage, avoidClones, horizon }, promptTokens, completionTokens });
    return json({ ok: true, reply: intent.reply, clarify: intent.clarify, intent: effective, ...selection, model: deps.env.model, latencyMs });
  } catch (error) {
    const code = infeasible(error) ? "infeasible" : "unavailable";
    audit(code);
    return failure(code === "infeasible" ? 422 : 503, code);
  }
};

export const handlePreview = async (req: Request, deps: ChatDeps): Promise<Response> => {
  if (req.method !== "POST") return failure(405, "method_not_allowed");
  if (!deps.env.enabled) return failure(503, "disabled");
  const input = await readBody(req);
  if (input instanceof Response) return input;
  let intent: StrategyIntent;
  try {
    if (!object(input.body) || Object.keys(input.body).length !== 1 || !Object.hasOwn(input.body, "intent")) throw new Error();
    const parsed = parseStrategyIntent(input.body.intent);
    if (deps.env.apiKey && JSON.stringify(parsed).includes(deps.env.apiKey)) throw new Error();
    // Only the structured fields matter for a preview. The visitor's free text (reply, clarify) is not stored
    // and does not enter the hash: nothing a visitor typed ends up in the database or in an operator's view.
    intent = Object.freeze({ ...parsed, reply: PREVIEW_REPLY, clarify: null });
  } catch {
    return failure(400, "bad_request");
  }
  const started = deps.now();
  const audit = (outcomeCode: string) => deps.log("preview", { requestHash: input.requestHash, latencyMs: deps.now() - started, outcomeCode });
  try {
    const reservation = await reserve(req, deps, "preview");
    if (!reservation.ok) { audit(reservation.reason); return denied(reservation); }
    const { intent: effective, shortlist: { addresses } } = selectStrategy(intent, deps.basePolicy, await deps.finalists());
    const preview = buildPreview({ intent: effective, basePolicy: deps.basePolicy, addresses });
    const requestId = deps.newId();
    await deps.requests.save({ id: requestId, createdAtMs: deps.now(), previewHash: preview.previewHash, intent: effective, preview });
    audit("ok");
    return json({ ok: true, requestId, preview });
  } catch (error) {
    const code = error instanceof PreviewError && error.code === "too_few_sources" ? "too_few_sources" : infeasible(error) ? "infeasible" : "unavailable";
    audit(code);
    return failure(code === "unavailable" ? 503 : 422, code);
  }
};

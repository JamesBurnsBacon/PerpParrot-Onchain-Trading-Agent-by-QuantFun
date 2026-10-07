// Voice confirmation without trusting the model: the browser asks the backend for a summary and a read-only dry-run sketch,
// remembers what it showed (a nonce, the intent and the preview hash), and saves a PENDING simulation request only when the
// visitor's OWN words after the summary say yes (or the visitor presses the on-screen button). Nothing here places an order.
import { isDryRunPlan, type DryRunPlan } from "../../shared/dry-run-plan";
import type { StrategyIntent } from "../../shared/strategy-intent";
import { walletNickname } from "../../shared/wallet-persona";
import { isApiError, isPreviewResponse, type PreviewResponse } from "./parrot";
import type { LiveEvents } from "./parrot-live";
import type { LiveCard } from "./parrot-reads";
import type { ConfirmToolName } from "./parrot-read-tools";

type Transcripts = LiveEvents["transcripts"];
type Posted<T> = { data: T } | { error: { code: string } };
export type Poster = <T>(path: string, body: unknown, guard: (v: unknown) => v is T) => Promise<Posted<T>>;

export const CONFIRM_WINDOW_MS = 90_000;
const FACTS_MAX = 1200;

// English and Japanese. A confirmation needs an affirmative and no negation or hedge in what the visitor said after the summary.
const AFFIRM = /\b(yes|yeah|yep|yup|sure|ok|okay|confirm|confirmed|go ahead|do it|lock it|save it|please do|sounds good|that'?s right|correct)\b|はい|うん|お願い|おねがい|確定して|保存して|いいよ|いいです|大丈夫|オーケー|オッケー|了解|それで/i;
const DENY = /\b(no|nope|not|don'?t|do not|wait|stop|cancel|never ?mind|hold on|actually|but|however|maybe|later)\b|いいえ|やめ|待って|まって|まだ|キャンセル|違う|ちがう|やっぱり|だめ|ダメ|でも|けど|あとで|後で/i;

// Did the visitor say yes after the summary? Only the visitor's own transcript after the summary counts, never the parrot's.
export const confirmedByUser = (transcripts: Transcripts, cursorMs: number): boolean => {
  const said = transcripts.filter(t => t.speaker === "user" && t.startMs >= cursorMs).map(t => t.delta).join(" ").trim();
  return said.length > 0 && AFFIRM.test(said) && !DENY.test(said);
};
export const cursorOf = (transcripts: Transcripts): number => transcripts.reduce((max, t) => Math.max(max, t.endMs), 0);
export const intentKey = (intent: unknown, addresses: string[]): string => JSON.stringify([intent, addresses]);

export type Pending = { nonce: string; key: string; previewHash: string; plan: DryRunPlan; sources: number; cursorMs: number; at: number; used: boolean };
export type ConfirmContext = {
  intent: StrategyIntent | null; addresses: string[]; transcripts: Transcripts;
  pending: Pending | null; setPending: (p: Pending | null) => void;
  now: () => number; newNonce: () => string; post: Poster;
};
export type ConfirmOutcome = { facts: string; card: LiveCard | null; saved?: PreviewResponse };

const record = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
type PlanResponse = { ok: true; previewHash: string; sources: number; plan: DryRunPlan };
const isPlanResponse = (v: unknown): v is PlanResponse => record(v) && v.ok === true && typeof v.previewHash === "string" && /^0x[0-9a-f]{64}$/.test(v.previewHash) &&
  typeof v.sources === "number" && isDryRunPlan(v.plan);

const usd = (v: number) => `$${Math.abs(v) >= 100 ? Math.round(Math.abs(v)) : Math.abs(v).toFixed(2)}`;
const cap = (text: string) => (text.length <= FACTS_MAX ? text : `${text.slice(0, FACTS_MAX - 1)}…`);
const unavailable = (tool: ConfirmToolName, what: string, facts: string): ConfirmOutcome => ({ facts: cap(facts), card: { kind: "unavailable", tool, what } });

export const planSentence = (plan: DryRunPlan): string => {
  const top = [...plan.orders].sort((a, b) => Math.abs(b.notionalUsd) - Math.abs(a.notionalUsd)).slice(0, 5)
    .map(o => `${o.isBuy ? "buy" : "sell"} ${o.asset} about ${usd(o.notionalUsd)}`).join(", ");
  const skipped = plan.skipped.length ? ` ${plan.skipped.length} legs would be skipped (too small or not tradable).` : "";
  const scaled = plan.marginScale < 1 ? ` The margin rule would scale everything to ${Math.round(plan.marginScale * 100)}%.` : "";
  return plan.orders.length
    ? `Dry-run sketch, hypothetical: a flat ${usd(plan.equityUsd)} account at current prices would open ${plan.orders.length} orders, about ${usd(plan.grossUsd)} gross: ${top}.${scaled}${skipped}`
    : `Dry-run sketch, hypothetical: at a flat ${usd(plan.equityUsd)} account this list would place no orders right now.${skipped}`;
};

const summaryFacts = (p: Pending, names: string[]): string => cap(
  `Confirmation summary: ${p.sources} wallets (${names.slice(0, 3).join(", ")}${names.length > 3 ? ", and more" : ""}). ${planSentence(p.plan)} ` +
  `Nothing is sent: confirming only saves a PENDING simulation request that an operator must review and freeze. ` +
  `Read this to the visitor and ask them to say yes. Only if they clearly say yes, call confirm_request with nonce ${p.nonce}.`);

async function save(ctx: ConfirmContext, p: Pending): Promise<ConfirmOutcome> {
  ctx.setPending({ ...p, used: true }); // one nonce saves at most once, even if the call is repeated while this is in flight
  const saved = await ctx.post("/live/request", { intent: ctx.intent, previewHash: p.previewHash }, isPreviewResponse);
  if ("error" in saved) {
    if (saved.error.code === "changed") {
      ctx.setPending(null);
      return unavailable("confirm_request", "Selection changed", "Not saved: the selection changed while we talked. Summarize it again with request_confirmation before the visitor confirms.");
    }
    ctx.setPending({ ...p, used: false });
    return unavailable("confirm_request", "Could not save", "Not saved: the request could not be saved just now. Tell the visitor and offer to try again; do not say it was saved.");
  }
  const { requestId, preview: { previewHash } } = saved.data;
  ctx.setPending(null);
  return {
    facts: cap(`Saved: request ${requestId} is PENDING with hash ${previewHash.slice(0, 10)}…, awaiting operator review and freeze. No orders were placed and nothing was applied. ${planSentence(p.plan)}`),
    card: { kind: "request", stage: "saved", plan: p.plan, previewHash, requestId, sources: p.sources },
    saved: saved.data,
  };
}

export async function runConfirmTool(name: ConfirmToolName, args: Record<string, unknown>, ctx: ConfirmContext): Promise<ConfirmOutcome> {
  if (name === "request_confirmation") {
    if (!ctx.intent || !ctx.addresses.length) return unavailable(name, "No strategy yet", "There is no shortlist to confirm yet. Ask the visitor for their strategy first; do not claim anything was saved.");
    const res = await ctx.post("/live/plan", { intent: ctx.intent }, isPlanResponse);
    if ("error" in res) return unavailable(name, "Could not prepare the sketch", "The dry-run sketch could not be prepared just now. Tell the visitor and do not confirm anything.");
    const pending: Pending = { nonce: ctx.newNonce(), key: intentKey(ctx.intent, ctx.addresses), previewHash: res.data.previewHash, plan: res.data.plan,
      sources: res.data.sources, cursorMs: cursorOf(ctx.transcripts), at: ctx.now(), used: false };
    ctx.setPending(pending);
    return { facts: summaryFacts(pending, ctx.addresses.map(walletNickname)), card: { kind: "request", stage: "awaiting", plan: pending.plan, previewHash: pending.previewHash, requestId: null, sources: pending.sources } };
  }
  const p = ctx.pending;
  const nonce = typeof args.nonce === "string" ? args.nonce : "";
  if (!p || p.used || nonce !== p.nonce) return unavailable(name, "Not confirmed", "Not saved: there is no open confirmation for that nonce. Summarize again with request_confirmation if the visitor still wants to confirm.");
  if (ctx.now() - p.at > CONFIRM_WINDOW_MS) { ctx.setPending(null); return unavailable(name, "Confirmation expired", "Not saved: the confirmation expired. Summarize again with request_confirmation."); }
  if (!ctx.intent || p.key !== intentKey(ctx.intent, ctx.addresses)) { ctx.setPending(null); return unavailable(name, "Selection changed", "Not saved: the strategy changed after the summary. Summarize again with request_confirmation."); }
  if (!confirmedByUser(ctx.transcripts, p.cursorMs)) return unavailable(name, "Waiting for your yes", "Not saved: I did not hear the visitor clearly say yes after the summary. Ask them to say yes or no; do not say it was saved.");
  return save(ctx, p);
}

// The on-screen confirm button: the visitor's own click stands in for the spoken yes. Same checks except the transcript.
export async function confirmByButton(ctx: ConfirmContext): Promise<ConfirmOutcome | null> {
  const p = ctx.pending;
  if (!p || p.used || !ctx.intent || ctx.now() - p.at > CONFIRM_WINDOW_MS || p.key !== intentKey(ctx.intent, ctx.addresses)) return null;
  return save(ctx, p);
}

export { isApiError };

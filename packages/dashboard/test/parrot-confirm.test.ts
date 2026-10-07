import { describe, expect, test } from "bun:test";
import { CONFIRM_WINDOW_MS, confirmByButton, confirmedByUser, cursorOf, runConfirmTool, type ConfirmContext, type Pending, type Poster } from "../lib/parrot-confirm";
import { initialLiveEvents, reduceLiveEvent } from "../lib/parrot-live";
import type { DryRunPlan } from "../../shared/dry-run-plan";
import type { StrategyIntent } from "../../shared/strategy-intent";

const T = (speaker: "user" | "parrot", delta: string, startMs: number, endMs = startMs + 500) => ({ speaker, delta, startMs, endMs });
const PLAN: DryRunPlan = { asOfMs: 1, equityUsd: 470, marginScale: 1, grossUsd: 150, skipped: [],
  orders: [{ asset: "BTC", isBuy: true, size: "0.00100", notionalUsd: 100, markPx: 100000 }, { asset: "ETH", isBuy: false, size: "0.0125", notionalUsd: -50, markPx: 4000 }] };
const HASH = `0x${"ab".repeat(32)}`;
const ADDRS = Array.from({ length: 5 }, (_, i) => `0x${(i + 1).toString(16).padStart(40, "0")}`);
const INTENT = { riskStyle: "conservative", maxSources: 5, diversification: "medium", leverageComfort: "low", requestedLeverage: null, avoidClones: true, horizon: "short", clarify: null, reply: "x" } as StrategyIntent;
const PREVIEW = { ok: true, requestId: "req-9", preview: { approvalRequired: true, version: "1", weighting: "equal (preview only)", policy: { mode: "SIMULATION" }, previewHash: HASH,
  sources: ADDRS.map(address => ({ address, weightUnits: 190000, ceilingUnits: 300000 })), cashUnits: 50000 } };

type Rig = { ctx: ConfirmContext; posts: { path: string; body: unknown }[]; state: { pending: Pending | null; now: number; transcripts: ReturnType<typeof T>[] } };
const rig = (reply: (path: string) => unknown = path => (path === "/live/plan" ? { ok: true, previewHash: HASH, sources: 5, addresses: ADDRS, plan: PLAN } : PREVIEW)): Rig => {
  const posts: Rig["posts"] = [];
  const state = { pending: null as Pending | null, now: 1_000_000, transcripts: [T("user", "Please lock this in.", 1000, 2500)] };
  const post: Poster = async (path, body, guard) => {
    posts.push({ path, body });
    const value = reply(path);
    if (value && typeof value === "object" && "error" in value) return value as never;
    return guard(value) ? { data: value } : { error: { code: "invalid_model_output" } };
  };
  const ctx = {
    get intent() { return INTENT; }, get addresses() { return ADDRS; }, get transcripts() { return state.transcripts; },
    get pending() { return state.pending; }, setPending: (p: Pending | null) => { state.pending = p; },
    now: () => state.now, newNonce: () => "n0nce123", post,
  } as ConfirmContext;
  return { ctx, posts, state };
};
// The summary is spoken by the parrot right after the cursor; the visitor's answer comes after that.
const summarize = async (r: Rig) => {
  const out = await runConfirmTool("request_confirmation", {}, r.ctx);
  r.state.transcripts.push(T("parrot", "Here is the summary. Say yes to save it.", (r.state.pending?.cursorMs ?? 0) + 500, (r.state.pending?.cursorMs ?? 0) + 7000));
  r.state.now += 5_000;
  return out;
};
const saves = (r: Rig) => r.posts.filter(p => p.path === "/live/request").length;

const spoken = (userSaid: string, startMs = 10_000) => [T("parrot", "Say yes to save it.", 5_000, 9_000), T("user", userSaid, startMs)];

describe("confirmedByUser: only the visitor's own whole-utterance yes, after the parrot began the summary", () => {
  test("short English and Japanese affirmatives", () => {
    for (const said of ["Yes", "Yes!", "yeah go ahead", "Okay, lock it in", "sure, do it", "Yes, please save it.", "はい", "はい、お願いします", "それで確定して", "大丈夫です"])
      expect(confirmedByUser(spoken(said), 4_000)).toBe(true);
  });
  test("refusals, hedges, questions and long sentences never confirm (positive control: the plain yes does)", () => {
    for (const said of ["no", "yes but wait", "not yet", "hold on", "actually cancel that", "Okay, don’t save it", "Okay, don't save it", "do not save it", "What does confirm mean?",
      "yes I think so but I am not sure at all about the second wallet", "いいえ", "やっぱりやめて", "はい、でも待って", "保存してはいけません", "保存しないで", "maybe later", "", "what is a funnel"])
      expect(confirmedByUser(spoken(said), 4_000)).toBe(false);
    expect(confirmedByUser(spoken("yes"), 4_000)).toBe(true);
  });
  test("a yes before the parrot began the summary, the parrot's own yes, or a summary that was never spoken is not a confirmation", () => {
    expect(confirmedByUser([T("parrot", "Summary.", 5_000, 9_000), T("user", "yes", 1_000, 1_500)], 4_000)).toBe(false); // before the summary
    expect(confirmedByUser([T("user", "yes", 10_000)], 4_000)).toBe(false);                                            // the parrot never spoke
    expect(confirmedByUser([T("parrot", "Yes! Saved!", 5_000, 9_000)], 4_000)).toBe(false);                            // only the parrot said yes
    expect(confirmedByUser([T("user", "yes", 4_500, 4_900), T("parrot", "Summary.", 5_000, 9_000)], 4_000)).toBe(false); // spoken while the summary was still being fetched
  });
  test("the cursor is the latest end time of anything said so far", () => {
    expect(cursorOf([T("user", "a", 0, 800), T("parrot", "b", 500, 1700)])).toBe(1700);
    expect(cursorOf([])).toBe(0);
  });
});

describe("runConfirmTool", () => {
  test("request_confirmation builds the summary, the sketch and a nonce, and saves nothing", async () => {
    const r = rig();
    const out = await summarize(r);
    expect(r.posts.map(p => p.path)).toEqual(["/live/plan"]);
    expect(saves(r)).toBe(0);
    expect(out.facts).toContain("n0nce123");
    expect(out.facts).toContain("hypothetical");
    expect(out.facts).toContain("Nothing is sent");
    expect(out.card).toMatchObject({ kind: "request", stage: "awaiting", previewHash: HASH });
    expect(r.state.pending).toMatchObject({ nonce: "n0nce123", used: false, previewHash: HASH });
  });
  test("the model cannot confirm on its own: no yes after the summary means no save", async () => {
    const r = rig();
    await summarize(r);
    const out = await runConfirmTool("confirm_request", { nonce: "n0nce123" }, r.ctx);
    expect(saves(r)).toBe(0);
    expect(out.facts).toContain("did not hear the visitor clearly say yes");
    expect(out.saved).toBeUndefined();
    // positive control: the same state plus the visitor's yes saves exactly once
    r.state.transcripts.push(T("user", "Yes, please.", 20_000));
    const ok = await runConfirmTool("confirm_request", { nonce: "n0nce123" }, r.ctx);
    expect(saves(r)).toBe(1);
    expect(ok.saved?.requestId).toBe("req-9");
    expect(ok.card).toMatchObject({ kind: "request", stage: "saved", requestId: "req-9" });
    expect(ok.facts).toContain("PENDING");
    expect(ok.facts).toContain("do not read them aloud");
    expect(ok.facts).toContain("No orders were placed");
    expect(r.posts.find(p => p.path === "/live/request")!.body).toEqual({ intent: INTENT, previewHash: HASH });
  });
  test("a nonce saves at most once, and a wrong, missing or expired nonce saves nothing", async () => {
    const r = rig();
    await summarize(r);
    r.state.transcripts.push(T("user", "yes", 20_000));
    expect((await runConfirmTool("confirm_request", { nonce: "wrong" }, r.ctx)).facts).toContain("no open confirmation");
    expect((await runConfirmTool("confirm_request", {}, r.ctx)).facts).toContain("no open confirmation");
    await runConfirmTool("confirm_request", { nonce: "n0nce123" }, r.ctx);
    const again = await runConfirmTool("confirm_request", { nonce: "n0nce123" }, r.ctx);
    expect(saves(r)).toBe(1);
    expect(again.saved).toBeUndefined();
    const late = rig();
    await summarize(late);
    late.state.transcripts.push(T("user", "yes", 20_000));
    late.state.now += CONFIRM_WINDOW_MS + 1;
    expect((await runConfirmTool("confirm_request", { nonce: "n0nce123" }, late.ctx)).facts).toContain("expired");
    expect(saves(late)).toBe(0);
  });
  test("with nothing summarized, or without a strategy, confirm and request both refuse", async () => {
    const r = rig();
    expect((await runConfirmTool("confirm_request", { nonce: "n0nce123" }, r.ctx)).saved).toBeUndefined();
    expect(saves(r)).toBe(0);
    const none = { ...r.ctx, intent: null, addresses: [] } as ConfirmContext;
    expect((await runConfirmTool("request_confirmation", {}, none)).facts).toContain("no shortlist");
    expect(r.posts).toHaveLength(0);
  });
  test("the server saying the selection changed voids the confirmation without a save", async () => {
    const r = rig(path => (path === "/live/plan" ? { ok: true, previewHash: HASH, sources: 5, addresses: ADDRS, plan: PLAN } : { error: { code: "changed" } }));
    await summarize(r);
    r.state.transcripts.push(T("user", "yes", 20_000));
    const out = await runConfirmTool("confirm_request", { nonce: "n0nce123" }, r.ctx);
    expect(out.facts).toContain("changed");
    expect(r.state.pending).toBeNull();
    expect(out.saved).toBeUndefined();
  });
  test("a save that certainly did not write can be retried; an ambiguous failure is never retried or reported as saved", async () => {
    let code: string | null = "rate_limited";
    const r = rig(path => (path === "/live/plan" ? { ok: true, previewHash: HASH, sources: 5, addresses: ADDRS, plan: PLAN } : code ? { error: { code } } : PREVIEW));
    await summarize(r);
    r.state.transcripts.push(T("user", "yes", 20_000));
    const first = await runConfirmTool("confirm_request", { nonce: "n0nce123" }, r.ctx);
    expect(first.facts).toContain("Not saved");
    expect(first.saved).toBeUndefined();
    expect(r.state.pending?.used).toBe(false); // rate limited: nothing was written, so the same yes can be used again
    code = "network";
    const ambiguous = await runConfirmTool("confirm_request", { nonce: "n0nce123" }, r.ctx);
    expect(ambiguous.facts).toContain("could not confirm whether the request was saved");
    expect(ambiguous.saved).toBeUndefined();
    expect(r.state.pending?.used).toBe(true); // the write may have landed: no automatic second save
    code = null;
    const after = await runConfirmTool("confirm_request", { nonce: "n0nce123" }, r.ctx);
    expect(after.saved).toBeUndefined();
    expect(saves(r)).toBe(2);
  });
  test("an answer for a confirmation that was replaced meanwhile publishes nothing and rearms nothing", async () => {
    const r = rig();
    await summarize(r);
    r.state.transcripts.push(T("user", "yes", 20_000));
    const replace = r.ctx.post;
    r.ctx.post = async (path, body, guard) => { const out = await replace(path, body, guard); r.state.pending = { ...r.state.pending!, nonce: "newer" }; return out; };
    const out = await runConfirmTool("confirm_request", { nonce: "n0nce123" }, r.ctx);
    expect(out.stale).toBe(true);
    expect(out.saved).toBeUndefined();
    expect(out.card).toBeNull();
    expect(r.state.pending?.nonce).toBe("newer");
  });
  test("a sketch for a different shortlist than the one on screen is refused", async () => {
    const r = rig(path => (path === "/live/plan" ? { ok: true, previewHash: HASH, sources: 5, addresses: [...ADDRS].reverse(), plan: PLAN } : PREVIEW));
    const out = await runConfirmTool("request_confirmation", {}, r.ctx);
    expect(out.card?.kind).toBe("unavailable");
    expect(r.state.pending).toBeNull();
  });
  test("asking again for the same open summary reuses the sketch and restarts the listening window", async () => {
    const r = rig();
    await summarize(r);
    const reads = r.posts.length;
    r.state.transcripts.push(T("user", "yes", 12_000, 12_500)); // said before the repeated summary: must not count afterwards
    const again = await runConfirmTool("request_confirmation", {}, r.ctx);
    expect(r.posts.length).toBe(reads);
    expect(again.facts).toContain("n0nce123");
    expect((await runConfirmTool("confirm_request", { nonce: "n0nce123" }, r.ctx)).saved).toBeUndefined();
    expect(saves(r)).toBe(0);
  });
  test("an unreadable plan is unavailable, never a made-up sketch", async () => {
    const r = rig(path => (path === "/live/plan" ? { error: { code: "network" } } : PREVIEW));
    const out = await runConfirmTool("request_confirmation", {}, r.ctx);
    expect(out.card?.kind).toBe("unavailable");
    expect(r.state.pending).toBeNull();
  });
  test("the Confirm button stands in for the spoken yes, with the same checks", async () => {
    const r = rig();
    expect(await confirmByButton(r.ctx)).toBeNull(); // nothing summarized yet
    await summarize(r);
    const out = await confirmByButton(r.ctx);
    expect(out?.saved?.requestId).toBe("req-9");
    expect(saves(r)).toBe(1);
    expect(await confirmByButton(r.ctx)).toBeNull(); // already used and cleared
  });
});

describe("the live reducer accepts the two confirmation tools and nothing else new", () => {
  const envelope = (nested: unknown) => ({ type: "response.event", delegation_id: "delegation_1", event: nested });
  const call = (name: string, args = "{}") => {
    let state = reduceLiveEvent(initialLiveEvents(), JSON.stringify({ type: "session.started" }));
    state = reduceLiveEvent(state, JSON.stringify(envelope({ type: "response.created", response: { id: "response_1" } })));
    return reduceLiveEvent(state, JSON.stringify(envelope({ type: "response.output_item.done", item: { type: "function_call", call_id: "call_1", name, arguments: args } }))).calls[0];
  };
  test("request_confirmation and confirm_request pass; look-alikes do not", () => {
    expect(call("request_confirmation").error).toBeUndefined();
    expect(call("confirm_request", '{"nonce":"abc"}').name).toBe("confirm_request");
    for (const name of ["confirm", "place_order", "freeze_request", "confirm_request "]) expect(call(name).error).toBeDefined();
  });
});

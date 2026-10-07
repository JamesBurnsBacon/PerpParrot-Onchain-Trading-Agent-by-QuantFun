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
const rig = (reply: (path: string) => unknown = path => (path === "/live/plan" ? { ok: true, previewHash: HASH, sources: 5, plan: PLAN } : PREVIEW)): Rig => {
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
const summarize = async (r: Rig) => { const out = await runConfirmTool("request_confirmation", {}, r.ctx); r.state.now += 5_000; return out; };
const saves = (r: Rig) => r.posts.filter(p => p.path === "/live/request").length;

describe("confirmedByUser: only the visitor's own words after the summary count", () => {
  test("English and Japanese affirmatives, with no negation or hedge", () => {
    for (const said of ["Yes", "yeah go ahead", "Okay, lock it", "sure, do it", "はい", "はい、お願いします", "それで確定して", "大丈夫です"])
      expect(confirmedByUser([T("user", said, 10_000)], 5_000)).toBe(true);
  });
  test("negations, hedges and silence do not confirm (positive control: the affirmative alone does)", () => {
    for (const said of ["no", "yes but wait", "not yet", "hold on", "actually cancel that", "いいえ", "やっぱりやめて", "はい、でも待って", "maybe later", "", "what is a funnel"])
      expect(confirmedByUser([T("user", said, 10_000)], 5_000)).toBe(false);
    expect(confirmedByUser([T("user", "yes", 10_000)], 5_000)).toBe(true);
  });
  test("a yes spoken before the summary, or the parrot saying yes, is not a confirmation", () => {
    expect(confirmedByUser([T("user", "yes", 1_000, 1_500)], 5_000)).toBe(false);
    expect(confirmedByUser([T("parrot", "Yes! Saved!", 10_000)], 5_000)).toBe(false);
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
    const r = rig(path => (path === "/live/plan" ? { ok: true, previewHash: HASH, sources: 5, plan: PLAN } : { error: { code: "changed" } }));
    await summarize(r);
    r.state.transcripts.push(T("user", "yes", 20_000));
    const out = await runConfirmTool("confirm_request", { nonce: "n0nce123" }, r.ctx);
    expect(out.facts).toContain("changed");
    expect(r.state.pending).toBeNull();
    expect(out.saved).toBeUndefined();
  });
  test("a failed save can be retried and is never reported as saved", async () => {
    let fail = true;
    const r = rig(path => (path === "/live/plan" ? { ok: true, previewHash: HASH, sources: 5, plan: PLAN } : fail ? { error: { code: "network" } } : PREVIEW));
    await summarize(r);
    r.state.transcripts.push(T("user", "yes", 20_000));
    const first = await runConfirmTool("confirm_request", { nonce: "n0nce123" }, r.ctx);
    expect(first.facts).toContain("Not saved");
    expect(first.saved).toBeUndefined();
    expect(r.state.pending?.used).toBe(false);
    fail = false;
    expect((await runConfirmTool("confirm_request", { nonce: "n0nce123" }, r.ctx)).saved?.requestId).toBe("req-9");
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

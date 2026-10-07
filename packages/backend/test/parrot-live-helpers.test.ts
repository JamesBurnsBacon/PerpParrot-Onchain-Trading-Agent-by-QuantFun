import { expect, test } from "bun:test";
import { functionResultMessages, hasUnfinishedLiveStrategy, initialLiveEvents, isLiveSession, isLiveStrategy, liveAsChat, pendingLiveCalls, reduceLiveEvent } from "../../dashboard/lib/parrot-live";
import recorded from "./fixtures/live-events.recorded.json";
import { PARROT_PRESETS } from "../../dashboard/lib/parrot-presets";

const event = (state: ReturnType<typeof initialLiveEvents>, data: unknown) => reduceLiveEvent(state, JSON.stringify(data));
const envelope = (nested: unknown, delegation_id = "delegation_1") => ({ type: "response.event", delegation_id, event: nested });
const created = (id = "response_1") => envelope({ type: "response.created", response: { id } });
const tool = (args = "{}", name = "set_strategy", call_id = "call_1") => envelope({ type: "response.output_item.done", item: { type: "function_call", call_id, name, arguments: args } });
const ready = () => event(event(initialLiveEvents(), { type: "session.started" }), created());

test("live reducer collects full-duplex captions exactly and retains timeline", () => {
  let state = event(initialLiveEvents(), { type: "session.started", session: { id: "live_x" } });
  expect(state.started).toBe(true);
  for (const [type, delta, start_ms, end_ms] of [
    ["session.input_transcript.delta", "こんにちは", 100, 300],
    ["session.output_transcript.delta", "はい", 150, 400],
    ["session.input_transcript.delta", " 少数 少数", 300, 500],
    ["session.output_transcript.delta", " <script>bad</script>", 400, 600],
  ] as const) state = event(state, { type, delta, start_ms, end_ms });
  expect(state.user).toBe("こんにちは 少数 少数");
  expect(state.parrot).toBe("はい <script>bad</script>");
  expect(state.transcripts).toHaveLength(4);
  expect(state.transcripts[0]).toEqual({ speaker: "user", delta: "こんにちは", startMs: 100, endMs: 300 });
});

test("live reducer associates delegation, response ID and completed function items", () => {
  let state = event(initialLiveEvents(), { type: "session.delegation.created", delegation: { id: "delegation_1", target: "responses", response_id: "response_1" } });
  expect(state.delegations).toEqual([{ id: "delegation_1", responseId: "response_1", running: true }]);
  state = event(state, created());
  state = event(state, envelope({ type: "response.function_call_arguments.done", arguments: "{}" }));
  expect(state.calls).toEqual([]);
  state = event(state, tool('{"maxSources":10}'));
  expect(state.calls).toEqual([{ callId: "call_1", responseId: "response_1", delegationId: "delegation_1", name: "set_strategy", args: { maxSources: 10 } }]);
  expect(state.readyResponses).toEqual([]);
  state = event(state, envelope({ type: "response.completed", response: { id: "response_1", output: [] } }));
  expect(state.calls).toHaveLength(1);
  expect(state.readyResponses).toEqual(["response_1"]);
  expect(state.delegations[0].running).toBe(false);
});

test("live ignores unknown envelopes, arguments-done and duplicate call IDs across responses", () => {
  const initial = initialLiveEvents();
  expect(event(initial, { type: "future.event" })).toBe(initial);
  expect(event(initial, tool())).toBe(initial);
  let state = event(ready(), tool());
  const once = state;
  expect(event(state, tool())).toBe(once);
  state = event(state, created("response_2"));
  state = event(state, tool());
  expect(state.calls).toHaveLength(1);
  state = event(state, tool("{}", "set_strategy", "call_2"));
  expect(state.calls[1].responseId).toBe("response_2");
});

test.each([['{', "set_strategy"], ['[]', "set_strategy"], ['null', "set_strategy"], ['{}', "web_search"], ['{}', "trade"], ['{"x":"' + "日".repeat(700) + '"}', "set_strategy"], [' '.repeat(2049), "set_strategy"]])("live malformed or oversized tool args become an error output: %s %s", (args, name) => {
  const state = event(ready(), tool(args, name));
  expect(state.calls).toHaveLength(1);
  expect(state.calls[0].args).toBeUndefined();
  expect(state.calls[0].error).toBe("Strategy could not be checked: invalid tool arguments.");
  const messages = functionResultMessages([{ callId: state.calls[0].callId, output: state.calls[0].error! }], "response_1");
  expect(messages[0]).toMatchObject({ type: "response.item.create", item: { type: "function_call_output", output: state.calls[0].error } });
});

test("live function results all precede exact continuation without client config", () => {
  expect(functionResultMessages([{ callId: "call_1", output: "Facts." }, { callId: "call_2", output: "Could not check." }], "response_1")).toEqual([
    { type: "response.item.create", event_id: "tool_call_1", item: { type: "function_call_output", call_id: "call_1", output: "Facts." } },
    { type: "response.item.create", event_id: "tool_call_2", item: { type: "function_call_output", call_id: "call_2", output: "Could not check." } },
    { type: "response.create", event_id: "continue_response_1" },
  ]);
});

test("live rejects malformed JSON and bounds event bytes and state growth", () => {
  for (const raw of ["{", "x".repeat(65537), JSON.stringify({ type: "x", delta: "日".repeat(22000) }), new ArrayBuffer(2)]) expect(reduceLiveEvent(initialLiveEvents(), raw).error).toBe(true);
  let state = ready();
  for (let i = 0; i < 129; i++) state = event(state, tool("{}", "set_strategy", `call_${i}`));
  expect(state.error).toBe(true);
  expect(state.calls).toHaveLength(128);
  state = initialLiveEvents();
  for (let i = 0; i < 300; i++) state = event(state, { type: "session.input_transcript.delta", delta: "x".repeat(100), start_ms: i, end_ms: i + 1 });
  expect(state.user).toHaveLength(4000);
  expect(state.transcripts).toHaveLength(256);
});

test("live session closed and provider errors stop accepting events without rendering error prose", () => {
  let state = event(ready(), { type: "session.closed", usage: { seconds: 9 } });
  expect(state.closed).toBe(true); expect(state.finalUsageSeconds).toBe(9);
  expect(event(state, tool())).toBe(state);
  state = event(ready(), { type: "error", error: { message: "secret provider error" } });
  expect(state.error).toBe(true);
  expect(JSON.stringify(state)).not.toContain("secret provider error");
});

test("live response validators reject unsafe shapes and bridge to existing page state", () => {
  const valid = { ok: true, session: { id: "live_123" }, transport: { sdp: "v=0" }, maxSessionSeconds: 180 };
  expect(isLiveSession(valid)).toBe(true);
  for (const seconds of [0, 901, 1.5, "180"]) expect(isLiveSession({ ...valid, maxSessionSeconds: seconds })).toBe(false);
  expect(isLiveSession({ ...valid, transport: { sdp: "bad" } })).toBe(false);
  const { intent, policy, shortlist } = PARROT_PRESETS[0].chat;
  const result = { ok: true as const, intent, policy, shortlist, evidence: shortlist.addresses.map((address, i) => ({ address, rank: i + 1, maxDrawdown: .1, realizedVol: .2, tags: [] })), facts: "Facts." };
  expect(isLiveStrategy(result)).toBe(true);
  expect(isLiveStrategy({ ...result, facts: "x".repeat(1201) })).toBe(false);
  expect(isLiveStrategy({ ...result, intent: { ...intent, maxSources: 1000 } })).toBe(false);
  expect(liveAsChat(result)).toMatchObject({ intent, policy, shortlist, reply: intent.reply, clarify: null });
});


test.each([false, true])("live recorded calls drain exactly once with completion first=%s", completionFirst => {
  // Drain after every event, including the empty completion before a late call.
  const events = [...recorded];
  const itemIndex = events.findIndex(e => e.event?.type === "response.output_item.done" && e.event.item?.type === "function_call");
  expect(itemIndex).toBeGreaterThan(-1);
  const completionIndex = events.findIndex((e, i) => i > itemIndex && e.event?.type === "response.completed");
  expect(completionIndex).toBeGreaterThan(itemIndex);
  if (completionFirst) [events[itemIndex], events[completionIndex]] = [events[completionIndex], events[itemIndex]];
  let state = initialLiveEvents();
  const processed = new Set<string>();
  const handled: string[] = [];
  const drain = () => {
    for (const call of pendingLiveCalls(state, processed)) {
      handled.push(call.callId);
      processed.add(call.callId);
    }
  };
  for (const entry of events) {
    if (entry.type === "session.closed") break;
    state = event(state, entry);
    drain();
    // Replayed provider events must not trigger another POST.
    state = event(state, entry);
    drain();
  }
  expect(handled).toEqual(["call_lUJIVgvPRO0gf81mioAqhUEi"]);
  expect(pendingLiveCalls(state, processed)).toEqual([]);
});

test("live drain picks up another call after the same response was handled", () => {
  let state = event(event(ready(), tool()), envelope({ type: "response.completed", response: { id: "response_1" } }));
  const processed = new Set<string>();
  expect(pendingLiveCalls(state, processed).map(c => c.callId)).toEqual(["call_1"]);
  processed.add("call_1");
  state = event(state, tool("{}", "set_strategy", "call_2"));
  expect(pendingLiveCalls(state, processed).map(c => c.callId)).toEqual(["call_2"]);
  processed.add("call_2");
  expect(pendingLiveCalls(state, processed)).toEqual([]);
  // A completion with no calls is quiescent (no recursive drain loop).
  expect(pendingLiveCalls(event(ready(), envelope({ type: "response.completed", response: { id: "response_1" } })), processed)).toEqual([]);
});


test("live ending with an unprocessed or in-flight strategy makes the previous plan stale", () => {
  const processed = new Set<string>();
  expect(hasUnfinishedLiveStrategy(ready(), processed)).toBe(false);
  let state = event(ready(), tool());
  // Before completion there is no POST yet, but the change must still invalidate the plan.
  expect(pendingLiveCalls(state, processed)).toEqual([]);
  expect(hasUnfinishedLiveStrategy(state, processed)).toBe(true);
  state = event(state, envelope({ type: "response.completed", response: { id: "response_1" } }));
  const [inFlight] = pendingLiveCalls(state, processed);
  expect(hasUnfinishedLiveStrategy(state, processed)).toBe(true);
  // All terminal paths must retain the unfinished-call evidence.
  for (const terminal of [{ type: "session.closed" }, { type: "error" }]) {
    expect(hasUnfinishedLiveStrategy(event(state, terminal), processed)).toBe(true);
  }
  processed.add(inFlight.callId); // Only after applying the POST result.
  expect(hasUnfinishedLiveStrategy(state, processed)).toBe(false);
  state = event(state, tool("{}", "set_strategy", "call_2"));
  expect(hasUnfinishedLiveStrategy(state, processed)).toBe(true);
});

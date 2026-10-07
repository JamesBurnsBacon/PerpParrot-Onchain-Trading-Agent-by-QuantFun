import { describe, expect, test } from "bun:test";
import recorded from "./fixtures/live-events.recorded.json";
import { initialLiveEvents, reduceLiveEvent } from "../../dashboard/lib/parrot-live";

// Events recorded from a real gpt-live-1 session (2026-10-06, typed input, Responses delegation to a backend model
// that called set_strategy). Guards the reducer against the real wire format, not only the documented one.
describe("recorded real GPT-Live events", () => {
  const replay = (events: unknown[]) => events.map(e => JSON.stringify(e)).reduce(reduceLiveEvent, initialLiveEvents());

  test("the reducer extracts the single set_strategy call with its ids and arguments", () => {
    const state = replay(recorded);
    expect(state.error).toBe(false);
    expect(state.started).toBe(true);
    expect(state.calls).toHaveLength(1);
    const call = state.calls[0];
    expect(call.error).toBeUndefined();
    expect(call.callId).toMatch(/^call_/);
    expect(call.responseId).toMatch(/^resp_/);
    expect(call.delegationId).toMatch(/^item_/);
    expect(call.args).toMatchObject({ riskStyle: "aggressive", requestedLeverage: 100, avoidClones: true });
  });

  test("replaying the same events twice does not duplicate the call", () => {
    expect(replay([...recorded, ...recorded]).calls).toHaveLength(1);
  });

  test("a call renamed to another tool is rejected, not executed", () => {
    const tampered = JSON.parse(JSON.stringify(recorded)) as typeof recorded;
    for (const e of tampered as { event?: { item?: { type?: string; name?: string } } }[]) {
      if (e.event?.item?.type === "function_call") e.event.item.name = "transfer_funds";
    }
    const call = replay(tampered).calls[0];
    expect(call?.args).toBeUndefined();
    expect(call?.error).toBeDefined();
  });
});

import { expect, test } from "bun:test";
import { BACKEND_INSTRUCTIONS, buildLiveConfig, CONFIRM_REQUEST_TOOL, EXPLAIN_WALLET_TOOL, REQUEST_CONFIRMATION_TOOL, GET_BACKTEST_TOOL, GET_RUN_STATUS_TOOL, LIVE_INSTRUCTIONS, liveReservationMicroUsd, readLiveEnv } from "../src/live/config";
import { STRATEGY_FIELD_GUIDE, CHAT_SYSTEM_PROMPT } from "../src/chat/prompt";
import { STRATEGY_INTENT_JSON_SCHEMA } from "../../shared/strategy-intent";

test("live config snapshot has the strict strategy function, three read-only Dashboard functions and server-owned settings", () => {
  const config = buildLiveConfig(readLiveEnv({}));
  const { reply, clarify, ...properties } = STRATEGY_INTENT_JSON_SCHEMA.schema.properties;
  expect(config).toEqual({ model: "gpt-live-1", instructions: LIVE_INSTRUCTIONS, audio: { output: { voice: "gleam" } }, client: { data_channel: { allowed_client_events: ["response.item.create", "response.create", "session.close"] } }, delegation: { type: "responses", responses: {
    model: "gpt-5.6-terra", instructions: BACKEND_INSTRUCTIONS, tools: [{ type: "function", name: "set_strategy", description: "Check bounded strategy preferences with code. Never trades or freezes.", strict: true,
      parameters: { type: "object", additionalProperties: false, properties, required: Object.keys(properties) } }, GET_RUN_STATUS_TOOL, EXPLAIN_WALLET_TOOL, GET_BACKTEST_TOOL, REQUEST_CONFIRMATION_TOOL, CONFIRM_REQUEST_TOOL], tool_choice: "auto", parallel_tool_calls: false, reasoning: { effort: "medium" }, max_output_tokens: 800,
  } } });
  expect(JSON.stringify(config)).not.toContain("web_search");
  expect(LIVE_INSTRUCTIONS.length).toBeLessThanOrEqual(2500);
  expect(BACKEND_INSTRUCTIONS).toContain(STRATEGY_FIELD_GUIDE);
  expect(BACKEND_INSTRUCTIONS).toContain("When the visitor asks about the live book, paper performance, or how the list compares, call set_strategy again with the unchanged preferences to refresh the facts, then answer ONLY from the facts.");
  expect(CHAT_SYSTEM_PROMPT).toContain(STRATEGY_FIELD_GUIDE);
  expect(new Bun.CryptoHasher("sha256").update(CHAT_SYSTEM_PROMPT).digest("hex")).toBe("dd2f22546f5c7fcd6d51d6ac2b330b57b91d6a627324fe158600d505743538fe");
});

test("the Dashboard and confirmation tools are strict, closed and cannot trade or freeze", () => {
  const tools = buildLiveConfig(readLiveEnv({})).delegation.responses.tools as readonly { name: string; strict: boolean; parameters: { additionalProperties: boolean; required: readonly string[] } }[];
  expect(tools.map(t => t.name)).toEqual(["set_strategy", "get_run_status", "explain_wallet", "get_backtest", "request_confirmation", "confirm_request"]);
  for (const tool of tools) { expect(tool.strict).toBe(true); expect(tool.parameters.additionalProperties).toBe(false); }
  expect(EXPLAIN_WALLET_TOOL.parameters.required).toEqual(["wallet"]);
  expect(CONFIRM_REQUEST_TOOL.parameters.required).toEqual(["nonce"]);
  expect(REQUEST_CONFIRMATION_TOOL.parameters.required).toEqual([]);
  for (const name of ["get_run_status", "explain_wallet", "get_backtest"]) { expect(BACKEND_INSTRUCTIONS).toContain(name); expect(LIVE_INSTRUCTIONS).toContain(name); }
  for (const name of ["request_confirmation", "confirm_request"]) expect(BACKEND_INSTRUCTIONS).toContain(name);
  expect(JSON.stringify([GET_RUN_STATUS_TOOL, EXPLAIN_WALLET_TOOL, GET_BACKTEST_TOOL, REQUEST_CONFIRMATION_TOOL, CONFIRM_REQUEST_TOOL])).not.toMatch(/pause_|resume_|flatten_|freeze_|place_order/);
});

test("live env defaults and invalid optional numbers never block startup", () => {
  const defaults = readLiveEnv({});
  expect(defaults).toEqual({ enabled: false, apiKey: undefined, model: "gpt-live-1", voice: "gleam", backendModel: "gpt-5.6-terra", backendReasoning: "medium", maxSessionSeconds: 180, ipHourly: 3, globalDaily: 30, voicePricePerMinUsd: 0.05, backendAllowanceUsd: 0.15 });
  for (const raw of ["NaN", "Infinity", "-1", ""]) {
    expect(readLiveEnv({ LIVE_MAX_SESSION_SECONDS: raw, LIVE_IP_HOURLY_LIMIT: raw, LIVE_GLOBAL_DAILY_LIMIT: raw, LIVE_VOICE_PRICE_PER_MIN_USD: raw, LIVE_BACKEND_ALLOWANCE_USD: raw })).toEqual(defaults);
  }
  for (const value of ["0", "901", "1.5"]) expect(readLiveEnv({ LIVE_MAX_SESSION_SECONDS: value }).maxSessionSeconds).toBe(180);
  expect(readLiveEnv({ LIVE_ENABLED: "TRUE" }).enabled).toBe(false);
  expect(readLiveEnv({ LIVE_ENABLED: "true" }).enabled).toBe(true);
  expect(readLiveEnv({ LIVE_MAX_SESSION_SECONDS: "900" }).maxSessionSeconds).toBe(900);
  expect(liveReservationMicroUsd(defaults)).toBe(300000);
  expect(liveReservationMicroUsd({ ...defaults, maxSessionSeconds: 1 })).toBe(162500);
});

test("the untrusted browser cannot send any event that reconfigures or steers the session", () => {
  const allowed = buildLiveConfig(readLiveEnv({})).client.data_channel.allowed_client_events;
  expect(allowed).toEqual(["response.item.create", "response.create", "session.close"]);
  for (const forbidden of ["session.update", "session.instructions.append", "session.thinking.append", "session.commentary.append"]) expect(allowed).not.toContain(forbidden);
});

test("parrot prompts describe exploration without claiming leverage is applied or clamped", () => {
  for (const instructions of [LIVE_INSTRUCTIONS, BACKEND_INSTRUCTIONS, CHAT_SYSTEM_PROMPT]) {
    expect(instructions).not.toMatch(/clamp|Limits are enforced by code|A hundred X|The code said no/);
    expect(instructions).toContain("preview");
    expect(instructions).toContain("applied or traded");
    expect(instructions).toContain("an operator must review and freeze");
  }
});

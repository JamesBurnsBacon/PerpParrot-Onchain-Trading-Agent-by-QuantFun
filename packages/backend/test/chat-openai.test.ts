import { expect, test } from "bun:test";
import { callIntentModel, ModelError } from "../src/chat/openai";
import { STRATEGY_INTENT_JSON_SCHEMA, type StrategyIntent } from "../../shared/strategy-intent";

const intent: StrategyIntent = {
  riskStyle: "aggressive", maxSources: 10, diversification: "low", leverageComfort: "high",
  requestedLeverage: null, avoidClones: false, horizon: "medium", clarify: null, reply: "Squawk, let's explore.",
};
const apiKey = "test-secret-never-echo";
const messages = [{ role: "system" as const, content: "Fill JSON." }, { role: "user" as const, content: "hello" }];
const result = (content = JSON.stringify(intent), finish_reason = "stop", refusal: string | null = null) => ({
  choices: [{ finish_reason, message: { content, refusal } }], usage: { prompt_tokens: 100, completion_tokens: 20 },
});
const mockFetch = (fn: (input: string | URL | Request, init?: RequestInit) => Promise<Response>): typeof fetch => Object.assign(fn, { preconnect: () => {} });

test("exact OpenAI request and validated response", async () => {
  const fetchImpl = mockFetch(async (url, init) => {
    expect(url).toBe("https://api.openai.com/v1/chat/completions");
    expect(init?.method).toBe("POST");
    expect(new Headers(init?.headers).get("Authorization")).toBe(`Bearer ${apiKey}`);
    expect(JSON.parse(String(init?.body))).toEqual({
      model: "test-model", messages, response_format: { type: "json_schema", json_schema: STRATEGY_INTENT_JSON_SCHEMA },
      max_completion_tokens: 400, store: false,
    });
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    return Response.json(result());
  });
  expect(await callIntentModel({ apiKey, model: "test-model", messages, fetchImpl })).toEqual({ intent, promptTokens: 100, completionTokens: 20 });
});

test.each([
  ["http", () => new Response(apiKey, { status: 500 })],
  ["http", () => new Response(apiKey, { status: 201 })],
  ["refusal", () => Response.json(result(apiKey, "stop", apiKey))],
  ["truncated", () => Response.json(result(JSON.stringify(intent), "length"))],
  ["invalid_output", () => Response.json(result(apiKey))],
  ["invalid_output", () => Response.json(result(JSON.stringify({ ...intent, extra: apiKey })))],
  ["invalid_output", () => Response.json(result(JSON.stringify({ ...intent, riskStyle: "wild" })))],
  ["invalid_output", () => Response.json(result("```json\n" + JSON.stringify({ ...intent, riskStyle: "wild" }) + "\n```"))],
  ["invalid_output", () => Response.json({ choices: [] })],
] as const)("sanitized %s", async (code, response) => {
  try {
    await callIntentModel({ apiKey, model: "test", messages, fetchImpl: mockFetch(async () => response()) });
    throw new Error("expected failure");
  } catch (error) {
    expect(error).toBeInstanceOf(ModelError);
    expect((error as ModelError).code).toBe(code);
    expect(String(error)).not.toContain(apiKey);
  }
});

test("timeout even when the injected fetch never resolves", async () => {
  await expect(callIntentModel({ apiKey, model: "test", messages, timeoutMs: 5,
    fetchImpl: mockFetch(() => new Promise<Response>(() => {})),
  })).rejects.toMatchObject({ code: "timeout" });
});

test("missing usage defaults to zero", async () => {
  const { usage, ...body } = result();
  const response = await callIntentModel({ apiKey, model: "test", messages, fetchImpl: mockFetch(async () => Response.json(body)) });
  expect(response.promptTokens).toBe(0);
  expect(response.completionTokens).toBe(0);
});

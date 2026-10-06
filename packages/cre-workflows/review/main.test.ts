import { describe, expect, test } from "bun:test";
import { buildAgentRequestBody, parseAgentResponse } from "./agent";
import { FIXTURE_FINALISTS } from "./fixtures";
import { initWorkflow, type Config } from "./main";

const completion = (content: unknown) => ({
  choices: [{ message: { content: JSON.stringify(content) } }],
});

const validOutput = {
  picks: [
    { id: "F01", weight: 0.6, rationale: "steady", redFlags: [] },
    { id: "F02", weight: 0.4, rationale: "low drawdown", redFlags: ["maker-heavy"] },
  ],
  rejected: [{ id: "F03", reason: "high leverage, sub-hour holds" }],
};

describe("buildAgentRequestBody", () => {
  test("requests strict structured output with the finalists", () => {
    const body = JSON.parse(buildAgentRequestBody(FIXTURE_FINALISTS, { model: "m" }));
    expect(body.model).toBe("m");
    expect(body.response_format.json_schema.strict).toBe(true);
    expect(body.reasoning_effort).toBeUndefined();
    expect(JSON.parse(body.messages[1].content).finalists).toHaveLength(3);
  });

  test("passes reasoning effort when set", () => {
    const body = JSON.parse(buildAgentRequestBody(FIXTURE_FINALISTS, { model: "m", reasoningEffort: "low" }));
    expect(body.reasoning_effort).toBe("low");
  });
});

describe("parseAgentResponse", () => {
  test("accepts a valid selection", () => {
    expect(parseAgentResponse(completion(validOutput), FIXTURE_FINALISTS).picks).toHaveLength(2);
  });

  test("rejects unknown ids", () => {
    const bad = { ...validOutput, rejected: [{ id: "F99", reason: "x" }] };
    expect(() => parseAgentResponse(completion(bad), FIXTURE_FINALISTS)).toThrow("unknown finalist");
  });

  test("rejects unclassified finalists", () => {
    const bad = { ...validOutput, rejected: [] };
    expect(() => parseAgentResponse(completion(bad), FIXTURE_FINALISTS)).toThrow("every finalist");
  });

  test("rejects weights that don't sum to 1", () => {
    const bad = { ...validOutput, picks: [{ ...validOutput.picks[0], weight: 0.3 }, validOutput.picks[1]] };
    expect(() => parseAgentResponse(completion(bad), FIXTURE_FINALISTS)).toThrow("sum to");
  });

  test("rejects an empty completion", () => {
    expect(() => parseAgentResponse({ choices: [] }, FIXTURE_FINALISTS)).toThrow("no message content");
  });
});

describe("initWorkflow", () => {
  test("registers one cron handler with the configured schedule", () => {
    const config: Config = {
      schedule: "0 0 * * * *",
      openaiUrl: "https://api.openai.com/v1/chat/completions",
      model: "m",
      timeoutSeconds: 60,
      secretsOwner: "",
    };
    const handlers = initWorkflow(config);
    expect(handlers).toHaveLength(1);
    expect(handlers[0].trigger.config.schedule).toBe("0 0 * * * *");
  });
});

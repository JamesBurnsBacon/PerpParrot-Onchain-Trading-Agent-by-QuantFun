import { parseStrategyIntent, STRATEGY_INTENT_JSON_SCHEMA, type StrategyIntent } from "../../../shared/strategy-intent";
import type { Message } from "./prompt";

export type ModelErrorCode = "timeout" | "http" | "refusal" | "truncated" | "invalid_output";
export class ModelError extends Error {
  constructor(readonly code: ModelErrorCode) {
    // Only our fixed code crosses the provider error boundary.
    super(`Intent model failed: ${code}`);
    this.name = "ModelError";
  }
}

const record = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const tokenCount = (value: unknown): number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : 0;

export const callIntentModel = async ({ apiKey, model, messages, fetchImpl = fetch, timeoutMs = 6000 }: {
  apiKey: string;
  model: string;
  messages: Message[];
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}): Promise<{ intent: StrategyIntent; promptTokens: number; completionTokens: number }> => {
  const signal = AbortSignal.timeout(timeoutMs);
  let onAbort = () => {};
  const timeout = new Promise<never>((_, reject) => {
    onAbort = () => reject(new ModelError("timeout"));
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    // Racing also bounds injected transports that do not implement signal cancellation.
    return await Promise.race([timeout, (async () => {
      let response: Response;
      try {
        response = await fetchImpl("https://api.openai.com/v1/chat/completions", {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
          body: JSON.stringify({ model, messages, response_format: { type: "json_schema", json_schema: STRATEGY_INTENT_JSON_SCHEMA }, max_completion_tokens: 400, store: false }),
          signal,
        });
      } catch {
        throw new ModelError(signal.aborted ? "timeout" : "http");
      }
      if (response.status !== 200) throw new ModelError("http");
      let body: Record<string, unknown>;
      try {
        body = record(await response.json());
      } catch {
        throw new ModelError("invalid_output");
      }
      if (!Array.isArray(body.choices) || !body.choices.length) throw new ModelError("invalid_output");
      const choice = record(body.choices[0]);
      const message = record(choice.message);
      if (message.refusal !== null && message.refusal !== undefined) throw new ModelError("refusal");
      if (choice.finish_reason !== "stop") throw new ModelError("truncated");
      let intent: StrategyIntent;
      try {
        if (typeof message.content !== "string" || (apiKey && message.content.includes(apiKey))) throw new Error();
        intent = parseStrategyIntent(JSON.parse(message.content));
      } catch {
        throw new ModelError("invalid_output");
      }
      const usage = record(body.usage);
      return { intent, promptTokens: tokenCount(usage.prompt_tokens), completionTokens: tokenCount(usage.completion_tokens) };
    })()]);
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
};

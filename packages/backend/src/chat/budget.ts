import { STRATEGY_INTENT_JSON_SCHEMA } from "../../../shared/strategy-intent";
import { buildMessages } from "./prompt";

export const MAX_MESSAGE_CHARS = 500;
export const MAX_HISTORY_TURNS = 6;
export const MAX_HISTORY_CHARS = 400;
export const MAX_COMPLETION_TOKENS = 400;

// Byte-level tokenizers need at most one token per UTF-8 byte. A lone surrogate
// serializes to six ASCII bytes, the largest JSON representation per UTF-16 unit.
// Include the actual prompt, history wrappers and schema, then double the entire
// serialized size to allow for provider message/schema framing. This intentionally
// over-reserves even when the HTTP byte limit rules out the largest character input.
const largestMessages = buildMessages(
  Array.from({ length: MAX_HISTORY_TURNS }, () => ({ role: "parrot" as const, text: "\ud800".repeat(MAX_HISTORY_CHARS) })),
  "\ud800".repeat(MAX_MESSAGE_CHARS),
);
export const MAX_INPUT_TOKENS = 2 * new TextEncoder().encode(JSON.stringify({
  messages: largestMessages,
  response_format: { type: "json_schema", json_schema: STRATEGY_INTENT_JSON_SCHEMA },
})).byteLength;

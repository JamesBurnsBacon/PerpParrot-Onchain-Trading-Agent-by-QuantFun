import { z } from "zod";

// Anonymized per-finalist input (README §4.6): no addresses, names or dates.
export type Finalist = {
  id: string;
  kind: "trader" | "hypercore-vault" | "erc4626-vault";
  sortino30d: number;
  calmar30d: number;
  maxDrawdown30d: number;
  pnlConsistency: number;
  avgLeverage: number;
  timeInMarket: number;
  medianHoldHours: number;
  makerShare: number;
  equityCurve: number[];
};

export const agentOutputSchema = z.object({
  picks: z
    .array(
      z.object({
        id: z.string(),
        weight: z.number().min(0).max(1),
        rationale: z.string(),
        redFlags: z.array(z.string()),
      }),
    )
    .min(1),
  rejected: z.array(z.object({ id: z.string(), reason: z.string() })),
});

export type AgentOutput = z.infer<typeof agentOutputSchema>;

// OpenAI strict structured outputs: every property required, no extras.
const outputJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["picks", "rejected"],
  properties: {
    picks: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["id", "weight", "rationale", "redFlags"],
        properties: {
          id: { type: "string" },
          weight: { type: "number" },
          rationale: { type: "string" },
          redFlags: { type: "array", items: { type: "string" } },
        },
      },
    },
    rejected: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["id", "reason"],
        properties: {
          id: { type: "string" },
          reason: { type: "string" },
        },
      },
    },
  },
} as const;

const SYSTEM_PROMPT = `You select source wallets for a Hyperliquid perps copy-trading portfolio.
Pick between 1 and 25 of the finalists and assign weights that sum to 1.
Prefer risk-adjusted performance, diversification, high time in market, and holding times long enough to copy with a 10-minute delay.
Flag martingale or wash-like behavior, concentration, high leverage and near-liquidation risk.
Every finalist must appear in exactly one of "picks" or "rejected".`;

export type AgentRequestOptions = {
  model: string;
  reasoningEffort?: string;
};

export const buildAgentRequestBody = (
  finalists: Finalist[],
  { model, reasoningEffort }: AgentRequestOptions,
): string =>
  JSON.stringify({
    model,
    ...(reasoningEffort ? { reasoning_effort: reasoningEffort } : {}),
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: JSON.stringify({ finalists }) },
    ],
    response_format: {
      type: "json_schema",
      json_schema: { name: "source_selection", strict: true, schema: outputJsonSchema },
    },
  });

// Parses an OpenAI chat completion and checks the selection against the finalists.
export const parseAgentResponse = (completion: unknown, finalists: Finalist[]): AgentOutput => {
  const content = (completion as { choices?: { message?: { content?: string | null } }[] })
    .choices?.[0]?.message?.content;
  if (!content) throw new Error("OpenAI response has no message content");

  const output = agentOutputSchema.parse(JSON.parse(content));

  const ids = new Set(finalists.map((f) => f.id));
  const seen = [...output.picks.map((p) => p.id), ...output.rejected.map((r) => r.id)];
  for (const id of seen) {
    if (!ids.has(id)) throw new Error(`Agent returned unknown finalist id: ${id}`);
  }
  if (new Set(seen).size !== seen.length) throw new Error("Agent listed a finalist more than once");
  if (seen.length !== ids.size) throw new Error("Agent did not classify every finalist");

  const total = output.picks.reduce((sum, p) => sum + p.weight, 0);
  if (Math.abs(total - 1) > 0.01) throw new Error(`Pick weights sum to ${total}, expected 1`);

  return output;
};

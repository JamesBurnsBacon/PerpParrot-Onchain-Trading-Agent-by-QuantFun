// Runs the Role and Risk analysts on a review input (scripts/review-input.ts) through runReview
// (README §4.6). Calls the model API: every node is one independent request, so --nodes 3 costs
// 6 requests. Writes the observations and the manifest; never freezes, signs or trades.
//
//   OPENAI_API_KEY=… bun run scripts/review-run.ts --input review-input.json [--model gpt-4.1-mini-2025-04-14]
//     [--nodes 3] [--quorum 2] [--out review-run.json] [--endpoint <OpenAI-compatible chat completions URL>]
//
// Off-chain, "nodes" are repeated calls to one provider; in CRE each DON node makes its own call.
// The red-team adapter is not built yet: a draft that reaches it ends as AGENT_FAILURE.
import { parseArgs } from "node:util";
import { runReview, type Dependencies } from "../../cre-workflows/review/workflow.ts";
import { bindCommitteeEvidence } from "../../shared/src/committee-evidence.ts";
import { RED_TEAM_PROMPT, RISK_PROMPT, ROLE_PROMPT, PROMPT_VERSION, promptHash } from "../../shared/src/prompts.ts";
import { createSpecialist, modelConfigHash, openAIChat, type ModelConfig, type Specialist } from "../../shared/src/specialists.ts";
import type { Frame, Observation, Policy } from "../../shared/src/contracts.ts";

const { values } = parseArgs({
  options: {
    input: { type: "string" }, model: { type: "string", default: "gpt-4.1-mini-2025-04-14" },
    nodes: { type: "string", default: "3" }, quorum: { type: "string", default: "2" }, out: { type: "string", default: "review-run.json" },
    endpoint: { type: "string" },
  },
});
if (!values.input) throw new Error("usage: review-run.ts --input <review-input.json> [--model …] [--nodes 3] [--quorum 2] [--out …]");
const apiKey = process.env.OPENAI_API_KEY ?? "";
const saved = (await Bun.file(values.input).json()) as { policy: Policy; frame: Frame; evidence: unknown; addresses: [number, string][] };
const addresses = new Map(saved.addresses);
// Re-binds and re-verifies everything from the file before any model call.
const committee = bindCommitteeEvidence(saved.frame, saved.policy, addresses, saved.evidence);

const config: ModelConfig = { provider: "openai", model: values.model!, temperature: 0, maxCompletionTokens: 4096 };
const nodeIds = Array.from({ length: Number(values.nodes) }, (_, i) => `node-${i + 1}`);
const call = openAIChat(apiKey, { endpoint: values.endpoint });
const captured: Record<Specialist, Observation[]> = { role: [], risk: [] };
const specialist = (kind: Specialist) => {
  const run = createSpecialist({ kind, evidence: committee, config, nodeIds, call, onError: (node, error) => console.warn(`${kind} ${node}: ${error.message}`) });
  return async (frame: Frame, signal: AbortSignal) => (captured[kind] = await run(frame, signal));
};
const deps: Dependencies = {
  quorum: Number(values.quorum), nodeIds, agentTimeoutMs: 60_000, clock: Date.now,
  rolePromptHash: promptHash(ROLE_PROMPT), riskPromptHash: promptHash(RISK_PROMPT), redTeamPromptHash: promptHash(RED_TEAM_PROMPT),
  modelConfigHash: modelConfigHash(config),
  role: specialist("role"), risk: specialist("risk"),
  redTeam: async () => { throw new Error("red-team adapter not built"); },
  assess: () => { throw new Error("execution assessment not built"); },
};
const manifest = await runReview(saved.frame, saved.policy, addresses, Date.now(), deps);

// Per candidate: the median of each field across the nodes that answered.
const median = (values: number[]) => { const s = [...values].sort((a, b) => a - b); return s.length ? s[Math.floor((s.length - 1) / 2)] : null; };
const summary = saved.frame.candidates.map(({ candidate }) => {
  const field = (kind: Specialist, name: string) => median(captured[kind].map((o) => o.results.find((r) => r.candidate === candidate)![name]!));
  return {
    candidate, address: addresses.get(candidate),
    aggressiveFit: field("role", "aggressiveFit"), reject: field("role", "reject"), roleConfidence: field("role", "confidence"),
    leverageRisk: field("risk", "leverageRisk"), evidenceRisk: field("risk", "evidenceRisk"), riskConfidence: field("risk", "confidence"),
  };
});
console.table(summary);
await Bun.write(values.out!, `${JSON.stringify({ promptVersion: PROMPT_VERSION, model: config, evidenceHash: committee.evidenceHash, observations: captured, summary, manifest }, null, 2)}\n`);
console.log(JSON.stringify({ marker: "REVIEW_RUN", out: values.out, status: manifest.status, reason: manifest.reason, sources: manifest.sources.length, roleNodes: captured.role.length, riskNodes: captured.risk.length }));

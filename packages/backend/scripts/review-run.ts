// Runs the committee review (Role, Risk, then Red-Team on a draft) on a review input from
// scripts/review-input.ts (README §4.6). Calls the model API: one request per stage, so up to 3.
// One honest provider node (quorum 1): one model call per stage.
// Every validated model output is appended to an audit file before the review counts it.
// Writes the receipt; never freezes, signs or trades (the receipt has no economic authority).
//
//   OPENAI_API_KEY=… bun run scripts/review-run.ts --input review-input.json [--model gpt-4.1-mini-2025-04-14]
//     [--out review-run.json] [--audit review-audit.jsonl] [--endpoint <OpenAI-compatible chat completions URL>]
import { appendFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { openAIPaperCommittee } from "../review/models/openai-paper.ts";
import { runCommitteeReview } from "../review/committee/workflow.ts";
import { commitment } from "../../shared/src/commitments.ts";
import { PROMPT_VERSION } from "../../shared/src/prompts.ts";
import type { Frame, Policy, Row } from "../../shared/src/contracts.ts";

const { values } = parseArgs({
  options: {
    input: { type: "string" }, model: { type: "string", default: "gpt-4.1-mini-2025-04-14" },
    out: { type: "string", default: "review-run.json" }, audit: { type: "string", default: "review-audit.jsonl" },
    endpoint: { type: "string" },
  },
});
if (!values.input) throw new Error("usage: review-run.ts --input <review-input.json> [--model …] [--out …] [--audit …] [--endpoint …]");
const saved = (await Bun.file(values.input).json()) as { policy: Policy; frame: Frame; evidence: unknown; addresses: [number, string][] };
const addresses = new Map(saved.addresses);

// Append-only local audit: one line per validated output, its id the commitment of the line.
const stageRows: Record<string, Row[][]> = {};
const deps = openAIPaperCommittee(
  { apiKey: process.env.OPENAI_API_KEY ?? "", model: values.model!, endpoint: values.endpoint },
  {
    clock: Date.now, agentTimeoutMs: 60_000,
    assess: () => { throw new Error("execution assessment not built"); },
    audit: async (stage, evidence, outputs, draft) => outputs.map((output) => {
      const record = { stage, evidenceHash: evidence.evidenceHash, output, ...(draft ? { draftHash: draft.draftHash } : {}) };
      appendFileSync(values.audit!, `${JSON.stringify(record)}\n`);
      if ("results" in output) (stageRows[stage] ??= []).push(output.results);
      return commitment("perpparrot:audit-record:v1", record);
    }),
  },
);
// runCommitteeReview re-binds and re-verifies the frame, evidence and commitments before any model call.
const receipt = await runCommitteeReview(saved.frame, saved.policy, addresses, saved.evidence, Date.now(), deps);

const field = (stage: string, candidate: number, name: string) => stageRows[stage]?.[0]?.find((r) => r.candidate === candidate)?.[name] ?? null;
const summary = saved.frame.candidates.map(({ candidate }) => ({
  candidate, address: addresses.get(candidate),
  aggressiveFit: field("role", candidate, "aggressiveFit"), reject: field("role", candidate, "reject"), roleConfidence: field("role", candidate, "confidence"),
  leverageRisk: field("risk", candidate, "leverageRisk"), evidenceRisk: field("risk", candidate, "evidenceRisk"), riskConfidence: field("risk", candidate, "confidence"),
}));
console.table(summary);
await Bun.write(values.out!, `${JSON.stringify({ promptVersion: PROMPT_VERSION, model: values.model, summary, receipt }, null, 2)}\n`);
const { manifest } = receipt;
console.log(JSON.stringify({ marker: "REVIEW_RUN", out: values.out, audit: values.audit, status: manifest.status, reason: manifest.reason, sources: manifest.sources.length, auditIds: receipt.auditIds.length, receiptHash: receipt.receiptHash }));

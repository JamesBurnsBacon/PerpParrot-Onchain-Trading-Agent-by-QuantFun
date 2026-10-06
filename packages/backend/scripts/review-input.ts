// Builds the AI review's input from scored candidates (README §4.6): Score -> finalists -> live positions
// -> a validated candidate-curation-frame 1.1.0 plus the anonymous evidence the models read. Read-only:
// it calls Hyperliquid's public info API and writes one JSON file.
//
//   bun run scripts/review-input.ts --inputs <score-inputs.json> [--policy <bucket-policy.json>] [--out review-input.json]
//
// <score-inputs.json> is a ScoreInput[] (`score:stored` writes one). Without --policy, the fixture
// configuration's policy is used with mode SIMULATION. Run scripts/review-run.ts within the policy's
// maxFrameAgeMs (the review refuses an older frame).
import { parseArgs } from "node:util";
import { buildReviewInput, positionsFromStates, type LivePosition } from "../review/input.ts";
import { validate } from "../../shared/src/validate.ts";
import type { Policy } from "../../shared/src/contracts.ts";
import { ELIGIBLE_DEXES } from "../../shared/snapshot";
import { scoreCandidates, toFrameCandidates, type ScoreInput } from "../src/score";
import { info } from "../src/hyperliquid";

const { values } = parseArgs({
  options: { inputs: { type: "string" }, policy: { type: "string" }, out: { type: "string", default: "review-input.json" } },
});
if (!values.inputs) throw new Error("usage: review-input.ts --inputs <score-inputs.json> [--policy <file>] [--out <file>]");

const inputs = (await Bun.file(values.inputs).json()) as ScoreInput[];
const policy: Policy = values.policy
  ? await Bun.file(values.policy).json()
  : { ...(await Bun.file(new URL("../fixtures/frozen-configuration.json", import.meta.url)).json()).policy, mode: "SIMULATION" };
validate("bucket-policy", policy);
if (!values.policy) console.warn("policy: fixture configuration's policy, mode SIMULATION (pass --policy to choose)");

const result = scoreCandidates(inputs);
const score = toFrameCandidates(result);
// toFrameCandidates stays pure; its caller logs what it left out (SPEC "Frame adapter").
for (const { address, reason } of score.skipped) console.warn(`frame: finalist ${address} left out (${reason})`);
if (score.candidates.length === 0) throw new Error(`no frame candidates (${result.finalists.length} finalists)`);

type State = Parameters<typeof positionsFromStates>[0][number];
const positions = new Map<string, LivePosition[]>();
for (const address of score.addresses) {
  const states = await Promise.all(ELIGIBLE_DEXES.map((dex) => info<State>({ type: "clearinghouseState", user: address, ...(dex ? { dex } : {}) })));
  positions.set(address.toLowerCase(), positionsFromStates(states));
}

const asOfMs = Date.now();
const built = buildReviewInput({ score, inputs, positions, policy, asOfMs, ttlMs: policy.maxFrameAgeMs });
for (const { address, reason } of built.skipped) console.warn(`review input: finalist ${address} left out (${reason})`);
await Bun.write(values.out!, `${JSON.stringify({ policy, frame: built.frame, evidence: built.evidence, addresses: [...built.addresses], skipped: [...score.skipped, ...built.skipped] }, null, 2)}\n`);
console.log(JSON.stringify({
  marker: "REVIEW_INPUT_BUILT", out: values.out, finalists: result.finalists.length, candidates: built.frame.candidates.length,
  skipped: score.skipped.length + built.skipped.length, snapshotHash: built.frame.snapshotHash, evidenceHash: built.committee.evidenceHash,
  asOf: new Date(asOfMs).toISOString(), expires: new Date(built.frame.expiresAtMs).toISOString(),
}));

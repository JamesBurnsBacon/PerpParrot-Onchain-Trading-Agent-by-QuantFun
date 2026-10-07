# Running and integrating the review core

The mirror path (frozen configuration → snapshot → target exposures → executor) is in
the README and [docs/ops](../ops/RUNBOOK.md). A real-provider review run and a review
schedule remain integration gates.

This repository has a server-side TypeScript review implementation, independent of
exchange submission. Requires Node 24+ and pnpm. Run `pnpm install
--frozen-lockfile`, `pnpm test`, and `pnpm typecheck` from the repository root.
`packages/backend/scripts/review-input.ts` builds the frame and evidence;
`packages/backend/scripts/review-run.ts` runs the committee through
`packages/backend/review/models/openai-paper.ts`.

Entrypoint: `packages/backend/review/workflow.ts::runReview`.
Shared TypeScript types: `packages/shared/src/contracts.ts`.
Strict JSON Schema validator: `packages/shared/src/validate.ts`.
The runtime rejects extra fields, nonfinite numbers, identity mismatches, missing
candidates and insufficient quorum. It does not coerce provider responses.

## Required adapters

`runReview(frame, policy, addressMap, nowMs, dependencies)` requires every dependency;
there is no permissive adapter implementation. Strict shape validation and commitment verification are built into the core.

| Dependency | Integration responsibility |
|---|---|
| clock / agentTimeoutMs | Monotonic epoch-millisecond clock and a bounded per-stage deadline (1–60,000ms) |
| quorum / nodeIds | Configured quorum and node allowlist (today one provider node, quorum 1), never model-provided IDs |
| prompt/model hashes | Exact versioned prompt and model configuration commitment |
| role / risk | Separate isolated model contexts, approved system prompts, deadlines and response size limits; return per-node observations |
| redTeam | Fresh context, numeric draft projection without source addresses; match draftHash |
| assess | Deterministic eligible-position replay/netting/drift/minimum-order capacity and worst-case active-source exposure validation |

The three model adapters must return observations from distinct configured nodes. A
node is one independent model observation; the current adapter supplies one honest
provider node (quorum 1), and several observations would be aggregated by median. The
core rejects duplicate/unknown node IDs and checks quorum against the configured
roster. IDs are transport metadata, not model output; the adapter must ensure that
each ID actually belongs to the call supplying the observation. IDs alone are
not a cryptographic proof. Shared model parameters
must be identical in an aggregation group. `role` and `risk` are invoked independently
in parallel, not sequentially with each other's answers. Return only rows from the
model and attach binding metadata in trusted orchestration code. The core bounds asynchronous stages and passes AbortSignal to adapters. Adapters must
honor cancellation and bound provider request sizes; the offline deadline cannot
interrupt synchronous CPU loops. Inputs are copied before awaiting models, and
freshness is rechecked through manifest issuance.

The core compiles a conservative deterministic allocation from bucket-fit scores scaled by the lower Role/Risk confidence,
execution latency and risk ceilings. Weights are capped and residual capital stays
in cash; no cap overflow is redistributed. Missing essential OOS/leverage/holding
period evidence excludes a candidate. Missing pair evidence prevents joint selection.
Risk dimensions determine binding constraints using lexical tie-breaking.

The latency multipliers (0.5 for 1–3h, 0.75 for 3–6h, 1 above 6h) are an initial
replay hypothesis, not calibrated trading parameters. Keep the core in simulation
until replay validates these constants and all bucket limits. A Red-Team multiplier
scales the **original draft weight and ceiling exactly once**. Excluded weights and
penalty residual stay in cash. No new candidate appears during rebuilding. PASS,
penalties and rebuilds all undergo the same final exposure/capacity assessment.

`assess` must calculate executable targets from actual eligible source positions,
capital, source equity, live account state, netting, $10 order floor and drift gates.
It must validate active-source weight renormalization, gross exposure and all market/
bucket constraints. A synthetic pass callback is used only in unit tests and must
never be used in a live adapter. Throws, invalid measurements or failed limits close
the result to INVALID_BUCKET with no sources and cash=1. Valid results include a
schema-checked manifest commitment. Commitments are computed internally by shared/commitments.ts using Keccak-256 over
UTF-8 canonical JSON `{domain,payload}`. Policy and snapshot commitments are recomputed
before inference; address mapping is part of the snapshot commitment. Use these exact
helpers in producers, not a different JSON/string/hash convention.

## Rollout boundary

The core runs under Node 24 and Bun on the server. It relies on structuredClone,
AbortController, setTimeout/clearTimeout, JSON imports and Ajv compilation. It runs
outside the 10-minute loop; if reviews are automated, the schedule (Vercel Cron or
AWS) is a separate, not yet decided integration step.

Persist valid review results to the existing `reviews`/`buckets` boundary only after
successful verification. A separate freeze step (`packages/backend/scripts/freeze.ts`)
writes the live configuration and its hash, which both services pin.
After freeze, hourly review output is commentary-only. Mirror must accept only the
frozen VALID live manifest and fresh state; it must never call `runReview`, model
adapters or narrative generation. Simulated manifests cannot authorize execution.
The mirror's targets/execute interface is unchanged by the review core: it
implements no orders, capital movement or transport changes.

Use SYSTEM_PROMPTS.md in adapters; model outputs never provide execution authority.
Narrative is optional dashboard content and is deliberately absent from this core.

Persisted manifests should pass `validateManifest`; mirror must call
`requireFrozenLiveManifest(manifest, nowMs, trustedFrozenHash)` before accepting it.
This helper rejects simulation, invalid status, mismatched freeze hashes, expired
manifests and semantic inconsistencies; it is not a signature verifier.

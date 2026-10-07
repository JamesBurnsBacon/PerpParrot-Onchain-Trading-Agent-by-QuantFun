# Running and integrating the review core

The mirror path (frozen configuration → snapshot → target exposures → executor) is in
the README and [docs/ops](../ops/RUNBOOK.md). Production selection and review run
through `packages/backend/src/pipeline/index.ts`, scheduled by Vercel Cron. See
[PIPELINE.md](../ingest/PIPELINE.md) and [ROSTER.md](../ingest/ROSTER.md) for the
review → bench → roster → active configuration path. This document describes the
strict review core's contracts, not an alternative production scheduler.

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

The core compiles a conservative deterministic allocation from bucket-fit scores,
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

The core runs under Node 24 and Bun on the server. Production orchestration is in
`packages/backend/src/pipeline/index.ts`: `select` builds measured evidence, calls
`openAIPaperCommittee` and `runCommitteeReview`, and persists output and its audit
under `selection_runs.review`. Approved wallets form a bench. The separate `roster`
job admits seats and freezes/activates a configuration when the seats change.

The configured `REVIEW_GATE` distinguishes the strict core manifest from the default
basic approval gate. Their rules are documented in [PIPELINE.md](../ingest/PIPELINE.md).
Do not describe a basic-gate selection as a strict-core PASS. The roster's deterministic
limits and frozen-configuration checks remain in force in either case.

Vercel schedules selection at `:x4` and roster updates at `:x6`; snapshot pre-builds
run at `:x9`. The long-running executor triggers the `:x0` mirror run. The mirror
consumes the active frozen configuration and snapshot-derived targets; it does not
call model adapters during execution. `backend/scripts/review-run.ts` and
`backend/scripts/freeze.ts` are explicit operator tools, not the cron entrypoints.

The review core also has a separate paper lifecycle and manifest-validation API
(`validateManifest`, `requireFrozenLiveManifest`). These are documented in
[PAPER_LIFECYCLE.md](PAPER_LIFECYCLE.md). Production snapshot and executor checks use
`packages/shared/frozen.ts` and the active/pinned configuration hash; do not substitute
an arbitrary model manifest for that execution authority.

Use SYSTEM_PROMPTS.md in adapters. Narrative is optional dashboard content and
cannot authorize orders. Current deployment evidence must be checked separately from
local tests; see [PRODUCTION_INTEGRATION.md](PRODUCTION_INTEGRATION.md).

# Running and integrating the review core

This repository now has an offline TypeScript review implementation, independent of
CRE networking and exchange submission. Requires Node 24+ and pnpm. Run `pnpm install
--frozen-lockfile`, `pnpm test`, and `pnpm typecheck` from the repository root.

Entrypoint: `packages/cre-workflows/review/workflow.ts::runReview`.
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
| quorum / nodeIds | Actual DON quorum and authenticated node allowlist, never model-provided IDs |
| prompt/model hashes | Exact versioned prompt and model configuration commitment |
| role / risk | Separate isolated model contexts, approved system prompts, deadlines and response size limits; return per-node observations |
| redTeam | Fresh context, numeric draft projection without source addresses; match draftHash |
| assess | Deterministic eligible-position replay/netting/drift/minimum-order capacity and worst-case active-source exposure validation |

The three model adapters must return observations from distinct authenticated DON
nodes. The core rejects duplicate/unknown node IDs and checks quorum against the configured
roster. IDs are transport metadata, not model output; the CRE adapter must authenticate
that each ID actually belongs to the node supplying the observation. IDs alone are
not a cryptographic proof. Shared model parameters
must be identical in a consensus group. `role` and `risk` are invoked independently
in parallel, not sequentially with each other's answers. Return only rows from the
model and attach binding metadata in trusted orchestration code. The core bounds asynchronous stages and passes AbortSignal to adapters. Adapters must
honor cancellation and bound capability request sizes; the offline deadline cannot
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

## CRE rollout boundary

No SDK or network provider is fabricated here: the upstream repository had no
installed CRE SDK, workflow config, runtime credentials, snapshots or executor code.
Before connecting this core, pin the SDK, compile the validator for the target
runtime (Ajv's compilation may require build-time standalone generation in WASM),
implement capability adapters with the installed APIs, and test production quotas.
The offline core relies on structuredClone, AbortController, setTimeout/clearTimeout,
JSON imports and Ajv compilation. CRE compatibility requires explicit build/runtime
adaptation and simulation; tests run under Node 24. This is not proof of CRE/WASM compatibility.

Persist valid review results to the existing `reviews`/`buckets` boundary only after
successful verification. A separate freeze adapter commits the live manifest/hash.
After freeze, hourly review output is commentary-only. Mirror must accept only the
frozen VALID live manifest and fresh state; it must never call `runReview`, model
adapters or narrative generation. Simulated manifests cannot authorize execution.
The existing signed `RebalanceReport`/execute interface remains an integration gate:
no report signing, orders, capital movement or transport changes are implemented.

Use SYSTEM_PROMPTS.md in adapters; model outputs never provide execution authority.
Narrative is optional dashboard content and is deliberately absent from this core.

Persisted manifests should pass `validateManifest`; mirror must call
`requireFrozenLiveManifest(manifest, nowMs, trustedFrozenHash)` before accepting it.
This helper rejects simulation, invalid status, mismatched freeze hashes, expired
manifests and semantic inconsistencies; it is not a DON signature verifier.

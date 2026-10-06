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
there is no permissive default implementation.

| Dependency | Integration responsibility |
|---|---|
| validate | Strict validation using shared schemas; validated scalar score vectors only |
| hash / verifyInput | Canonical domain-separated Keccak commitments; bind address mapping and recompute policy/data hashes |
| quorum | Actual DON configuration, never a provider-reported count |
| prompt/model hashes | Exact versioned prompt and model configuration commitment |
| role / risk | Separate isolated model contexts, approved system prompts, deadlines and response size limits; return per-node observations |
| redTeam | Fresh context, numeric draft projection without source addresses; match draftHash |
| assess | Deterministic eligible-position replay/netting/drift/minimum-order capacity and worst-case active-source exposure validation |

The three model adapters must return observations from distinct authenticated DON
nodes. The array length check alone cannot authenticate nodes: the CRE adapter must
prevent one node from contributing duplicate observations. Shared model parameters
must be identical in a consensus group. `role` and `risk` are invoked independently
in parallel, not sequentially with each other's answers. Return only rows from the
model and attach binding metadata in trusted orchestration code. Catch deadlines at
the adapter so a hung provider cannot hang the workflow indefinitely.

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
schema-checked manifest commitment. The hash adapter's result is trusted only after
its canonicalization and hashing implementation is independently tested.

## CRE rollout boundary

No SDK or network provider is fabricated here: the upstream repository had no
installed CRE SDK, workflow config, runtime credentials, snapshots or executor code.
Before connecting this core, pin the SDK, compile the validator for the target
runtime (Ajv's compilation may require build-time standalone generation in WASM),
implement capability adapters with the installed APIs, and test production quotas.
The core contains no Node builtins; tests use Node and schemas are loaded through
JSON imports in the offline validator. This is not proof of CRE/WASM compatibility.

Persist valid review results to the existing `reviews`/`buckets` boundary only after
successful verification. A separate freeze adapter commits the live manifest/hash.
After freeze, hourly review output is commentary-only. Mirror must accept only the
frozen VALID live manifest and fresh state; it must never call `runReview`, model
adapters or narrative generation. Simulated manifests cannot authorize execution.
The existing signed `RebalanceReport`/execute interface remains an integration gate:
no report signing, orders, capital movement or transport changes are implemented.

Use SYSTEM_PROMPTS.md in adapters; model outputs never provide execution authority.
Narrative is optional dashboard content and is deliberately absent from this core.

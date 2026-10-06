# Production integration status

Updated 2026-10-06 when the review core (branch `ai-agent-workflow`) and the CRE mirror path
(branch `cre-scaffold`) were merged; `docs/cre/INTEGRATION.md` records what came from where and
why. Nothing here authorizes real trades.

The [evidence-bound paper review integration](PAPER_LIFECYCLE.md) now connects rich
specialist inputs, per-node audit, persistent paper freeze and monitoring-only
reviews. A dry-run integration test follows the merged snapshot/report/executor
path; the removed parallel preview lane is not restored.

## Review core (this contribution)

| Component | Ownership and verified behavior |
| --- | --- |
| Anonymous rich review evidence | `shared/src/committee-evidence.ts` binds the summary frame, full curve/positions/patterns and matrix, rejects contradictions, and bounds the combined finalist at 4 KB. It does not turn the spike's scores into specialist judgments. |
| Audit persistence | `backend/review/audit.ts` persists bound prompt/evidence and strictly validated committee output through a service-only idempotent RPC (`persist_review_audit`, `supabase/migrations/20261006130000_review_audit.sql`). Real provider output has not been persisted yet. |
| CRE review spike | `cre-workflows/review-spike`: real SDK HTTP calls, per-node structured output, per-field median consensus (see `CRE_SPIKE.md`). |
| Review input from Score | `backend/review/input.ts` (`buildReviewInput`, run by `backend/scripts/review-input.ts`): Score finalists -> a candidate-curation-frame **1.1.0** (adds `isSharpe`, `isSortino`, `isCalmar`, `lookbackDays`, `scoreFlags`, `cloneCount`; clone addresses stay at candidate level for audit) and the anonymous evidence (month PnL curve, up to 12 live positions, fill patterns `null` until fills are ingested). Fields no module supplies yet are `null` = unknown, and `compile` rejects candidates without OOS and execution evidence, so no candidate can pass yet. |
| Role/Risk model adapters | `shared/src/specialists.ts`: one OpenAI-compatible Chat Completions call per node with the versioned prompt (`shared/src/prompts.ts`, byte-identical to `SYSTEM_PROMPTS.md` v1.1.0), the bound committee evidence as the user payload and a strict integer row schema read from the consensus schemas. `backend/scripts/review-run.ts` runs them through `runReview` off-chain. Not yet: the red-team adapter, CRE wiring and secrets, and a real-provider run. |
| Frozen configuration | `shared/src/frozen.ts` (`proposeFreeze`): the review's output that becomes the mirror's only execution authority. LIVE is **Aggressive** only (README §4.3). |

## Mirror path (moved)

The paper mirror, execution preview compiler, recovery/nonce store, chain-authority adapter,
HyperEVM freeze consumer and preview tables that were here were replaced by the CRE mirror path:

| Need | Where it is now |
| --- | --- |
| Snapshot producer at `:x9` | `packages/backend` (immutable per-run snapshots, eligibility, Postgres) |
| CRE mirror wrapper | `packages/cre-workflows/mirror` (HMAC-keyed spot-check sampling with a CRE secret, from this contribution's mirror spike) |
| Live report + delivery | DON-signed exposures report, `sendReport()` → executor (README §4.13) |
| Execution | `packages/executor`: signature verification, planner (HL lot/tick rounding via `@nktkas/hyperliquid`, $10 minimum at the limit price, 95% margin rule, reduce-only), dry run by default |
| Freeze confirmation | `configurationHash` pinned in the mirror config, backend and executor (no onchain contract) |
| Health and alerts | executor watchdog + Telegram |

## Remaining gates for the review core

1. Complete deployed Role/Risk/Red-Team CRE capability adapters. Rich evidence,
   server provider requests, per-node audit and paper monitoring-only behavior now
   have integration tests; actual deployed DON committee runs remain a gate.
2. Run the two-model point-in-time evaluation, select the winner and persist the full
   sanitized prompt/output audit with verified hashes and paper shadow state.
3. Configure CRE/model secrets; run authenticated LLM simulations and verify deployed
   consensus and request quotas.
4. Produce the Aggressive LIVE frozen configuration for our account and freeze it
   (`packages/backend/scripts/freeze.ts`).

## Remaining gates for funded execution

The executor now has a durable write-ahead journal for leverage changes and IOC order
batches. Startup and pre-report recovery detect unresolved journal rows and hold report
execution; `GET /admin/order-batches` exposes the evidence needed for operator review.
This is crash containment, not automatic exchange reconciliation or proof that an
exchange request is idempotent. The operator must reconcile each unresolved action
against Hyperliquid before resuming.

Before any funded canary, require all of the following:

1. Apply and verify the executor journal migration on the intended Supabase project;
   exercise the Postgres tests against that schema and confirm persistence across an
   executor restart.
2. Run the recovery drill on paper: leave an order batch in `dispatching`, stop the
   executor, restart it, verify the durable pause and operator listing, reconcile with
   recorded evidence, and confirm it stays paused until explicit resume. Also test a
   database outage before journal creation and after exchange dispatch.
3. During reconciliation, stop/fence every executor instance first. The admin endpoint
   records an operator attestation; it does not query Hyperliquid or prove the old
   process has stopped. Never clear a dispatching record while its originating process
   may still be executing.
4. Configure CRE and model secrets, run authenticated simulation, validate real DON
   consensus and report delivery, then complete repeated dry-run/soak and injected
   failure tests with the deployed services.
5. Verify the exact account, API-wallet permissions, frozen-configuration hash,
   workflow name, DON id, exposure/leverage limits, alert delivery, pause/flatten
   procedures and an operator-reviewed small canary plan. No hosted deployment or
   funded execution has been verified by local tests.

## Local checks

Review core: `pnpm install --frozen-lockfile`, `pnpm typecheck`, `pnpm test`, `pnpm test:cre`,
`pnpm compile:review-spike`, and `python tests/validate_contracts.py` (with jsonschema installed).
Mirror path: `bun test` in each of `packages/backend`, `packages/executor`,
`packages/cre-workflows/mirror`, and `./scripts/e2e-mirror.sh all`.

Server code and CRE handlers have separate TypeScript scopes because CRE globally restricts
Node APIs. Do not import server HTTP, filesystem, SQL, timers or crypto modules into CRE.

Set `TEST_DATABASE_URL` and apply both mirror and order-journal migrations to exercise
the durable store. The in-memory tests do not validate Postgres transaction behavior.

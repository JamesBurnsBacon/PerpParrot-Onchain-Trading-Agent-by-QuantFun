# Production integration status

Updated 2026-10-07 after the review core and the mirror path were merged: the mirror is
the backend and executor services on Vercel, and the review committee runs server-side
in `packages/backend/review`.
[Runbook](../ops/RUNBOOK.md) and [deploy guide](../ops/DEPLOY.md) cover operations.
Nothing here authorizes real trades.

Current review work: the scheduled pipeline now supplies measured evidence and local
real-provider rehearsals exercise its strict review and configuration path. See
[measurement definitions](STRICT_EVIDENCE.md) for scope and reproduction. Local success
does not establish production deployment or the strict gate's 12/40 acceptance target;
the basic fallback remains available.

The [evidence-bound paper review integration](PAPER_LIFECYCLE.md) now connects rich
specialist inputs, per-node audit, persistent paper freeze and monitoring-only
reviews. A dry-run integration test follows the merged snapshot/targets/executor
path; the removed parallel preview lane is not restored.

## Review core (this contribution)

| Component | Ownership and verified behavior |
| --- | --- |
| Anonymous rich review evidence | `shared/src/committee-evidence.ts` binds the summary frame, full curve/positions/patterns and matrix, rejects contradictions, and bounds the combined finalist at 4 KB. It does not turn the spike's scores into specialist judgments. |
| Audit persistence | `backend/review/audit.ts` persists bound prompt/evidence and strictly validated committee output through a service-only idempotent RPC (`persist_review_audit`, `supabase/migrations/20261006130000_review_audit.sql`). Real provider output has not been persisted yet. |
| Review core | `backend/review/workflow.ts` (`runReview`) and `backend/review/committee/`: Role/Risk/Red-Team over the bound evidence, per-node structured output, per-field median aggregation when there are several observations. |
| Review input from Score | `backend/review/input.ts` (`buildReviewInput`): Score finalists -> a candidate-curation-frame **1.1.0** and anonymous evidence. The scheduled pipeline supplies hold/leverage, recent-window diagnostics, execution fit, overlap, measured fill patterns, daily BTC beta and current cross-asset exposure. Missing values stay unknown; recent-window diagnostics are within the selection lookback, not independent out-of-sample validation. |
| Server-side model provider | `backend/review/models/openai-paper.ts` (`openAIPaperCommittee`): Role, Risk and Red-Team over bound evidence, one provider node (quorum 1), strict output schemas. This branch proposes prompts byte-identical to `SYSTEM_PROMPTS.md` v1.2.0; [the local calibration](PROMPT_CALIBRATION_20261007.md) is paper-only and does not verify deployment. The scheduled pipeline persists its audit in `selection_runs.review`; `strict-gate-check.ts` exercises this with real calls in a local database. This does not verify the separate `persist_review_audit` RPC in production. |
| Frozen configuration | `shared/src/frozen.ts` (`proposeFreeze`): the review's output that becomes the mirror's only execution authority. LIVE is **Aggressive** only (README §4.3). |

## Mirror path

The paper mirror, execution preview compiler, recovery/nonce store, chain-authority adapter,
HyperEVM freeze consumer and preview tables that were here were replaced by the mirror run:

| Need | Where it is now |
| --- | --- |
| Snapshot producer at `:x9` | `packages/backend` (Vercel Cron pre-builds each run's immutable positions snapshot from Hyperliquid; eligibility, Postgres) |
| Target exposures | `targetsFromSnapshot` (`packages/shared/copy.ts`), served by the backend at `GET /targets/:runAt`; the same function feeds the paper books |
| Trigger and delivery | Vercel Cron calls the executor's `/cron/run` at `:x0`; it fetches the targets over the service binding (`BACKEND_URL`). Live trading needs one long-running executor process with its own timer |
| Execution | `packages/executor`: configurationHash and account check, per-run claim (`executor_run_claims`), planner (HL lot/tick rounding via `@nktkas/hyperliquid`, $10 minimum at the limit price, 95% margin rule, reduce-only), dry run by default |
| Freeze confirmation | `configurationHash` pinned in both services' env (`FROZEN_CONFIGURATION_HASH`; no onchain contract) |
| Run evidence | `executor_runs.evidence` = `{snapshotHash, configurationHash, exposures}`; the snapshot is public at `/api/backend/snapshots/<runAt>` and its keccak256 can be recomputed |
| Health and alerts | executor watchdog + Telegram |

## Remaining gates for the review core

1. Reach the strict gate's acceptance target on repeated real-provider observations:
   at least 12/40 candidate passes in most runs and a VALID manifest with at least five
   sources. Local real calls and audit persistence have been exercised; production
   deployment and reliability remain separate checks. Keep the basic fallback.
2. Run the two-model point-in-time evaluation, select the winner and persist the full
   sanitized prompt/output audit with verified hashes and paper shadow state.
3. Verify the implemented Vercel Cron pipeline on the deployed environment, including
   the server-only model key, migrations and persisted audit.
4. Produce the Aggressive LIVE frozen configuration for our account and freeze it
   (`packages/backend/scripts/freeze.ts`, then set `FROZEN_CONFIGURATION_HASH` in both
   services).

## Remaining gates for funded execution

The executor now has a durable write-ahead journal for leverage changes and IOC order
batches. Each run first reconciles unresolved journal rows automatically
(`packages/executor/src/reconcile.ts`), under the cross-process run lock. Every action is
signed with `expiresAfter`, so past that time it has either landed or never will: the run
records Hyperliquid's `orderStatus` per client order ID (`activeAssetData` for leverage) as
evidence and trades against the live account. Before expiry, a row closes only when every
order is final; otherwise that run leaves its perps alone and trades the rest. Nothing pauses
automatically: only a human pauses or flattens. `GET /admin/order-batches` and
`POST /admin/reconcile-batch` remain for manual review.

Before any funded canary, require all of the following:

1. Apply and verify the executor journal migration on the intended Supabase project;
   exercise the Postgres tests against that schema and confirm persistence across an
   executor restart.
2. Run the recovery drill on paper: leave an order batch in `dispatching`, stop the
   executor, restart it, and verify that the next run reconciles it automatically (with
   Hyperliquid's order status as evidence), alerts, and trades on without pausing. Also
   test a database outage before journal creation and after exchange dispatch.
3. Run exactly one live executor: the run lock fences runs across processes, and the
   signed expiry bounds how long an old process's action can still land. A manual
   `POST /admin/reconcile-batch` is an operator attestation; it doesn't query Hyperliquid.
4. Run the long-running live executor process (e.g. Railway) against the deployed
   backend, then complete repeated dry-run/soak and injected failure tests with the
   deployed services.
5. Verify the exact account, API-wallet permissions, frozen-configuration hash,
   exposure/leverage limits, alert delivery, pause/flatten procedures and an
   operator-reviewed small canary plan. No hosted deployment or
   funded execution has been verified by local tests.

## Local checks

Review core (CI: `agent-review-checks.yaml`): `pnpm install --frozen-lockfile`, `pnpm typecheck`,
`pnpm test`, `pnpm paper:lifecycle`, and `python tests/validate_contracts.py` (with jsonschema
installed). Mirror path (CI: `service-checks.yml`): `bun test` in each of `packages/backend` and
`packages/executor`, and `./scripts/e2e-mirror.sh all`.

Set `TEST_DATABASE_URL` and apply both mirror and order-journal migrations to exercise
the durable store. The in-memory tests do not validate Postgres transaction behavior.

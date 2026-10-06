# Production integration status

Updated 2026-10-07 after the review core and the mirror path were merged: the mirror is
the backend and executor services on Vercel, and the review committee runs server-side
in `packages/backend/review`.
[Runbook](../ops/RUNBOOK.md) and [deploy guide](../ops/DEPLOY.md) cover operations.
Nothing here authorizes real trades.

Follow-up, 2026-10-07: [PR #33's measured rehearsal](../../night-shift-integration/FOLLOWUP_REPORT.md)
fed 25 real public accounts through the production Review and SQL audit. GPT-4.1 mini
and GPT-4.1 each completed Role and Risk (four HTTP 200 responses, four validated audit
rows, zero retries). Both reviews returned `INVALID_BUCKET / INSUFFICIENT_EVIDENCE`:
no real-data freeze, Red-Team call or executor run followed. Evidence is isolated
paper/PGlite and GitHub Actions, not the production database or a hosted review schedule.

The [evidence-bound paper review integration](PAPER_LIFECYCLE.md) now connects rich
specialist inputs, per-node audit, persistent paper freeze and monitoring-only
reviews. A dry-run integration test follows the merged snapshot/targets/executor
path; the removed parallel preview lane is not restored.

## Review core (this contribution)

| Component | Ownership and verified behavior |
| --- | --- |
| Anonymous rich review evidence | `shared/src/committee-evidence.ts` binds the summary frame, full curve/positions/patterns and matrix, rejects contradictions, and bounds the combined finalist at 4 KB. It does not turn the spike's scores into specialist judgments. |
| Audit persistence | `backend/review/audit.ts` persists bound prompt/evidence and strictly validated committee output through a service-only idempotent RPC (`persist_review_audit`, `supabase/migrations/20261006130000_review_audit.sql`). The measured rehearsal persisted four real-provider rows in isolated PGlite; intended Supabase persistence still needs deployment validation. |
| Review core | `backend/review/workflow.ts` (`runReview`) and `backend/review/committee/`: Role/Risk/Red-Team over the bound evidence, per-node structured output, per-field median aggregation when there are several observations. |
| Review input from Score | `backend/review/input.ts` (`buildReviewInput`, run by `backend/scripts/review-input.ts`): Score finalists -> a candidate-curation-frame **1.1.0** (adds `isSharpe`, `isSortino`, `isCalmar`, `lookbackDays`, `scoreFlags`, `cloneCount`; clone addresses stay at candidate level for audit) and the anonymous evidence (month PnL curve, up to 12 live positions, fill patterns `null` until fills are ingested). Fields no module supplies yet are `null` = unknown, and `compile` rejects candidates without OOS and execution evidence, so no candidate can pass yet. |
| Server-side model provider | `backend/review/models/openai-paper.ts` (`openAIPaperCommittee`): Role, Risk and Red-Team over the bound committee evidence, one honest provider node (quorum 1), strict output schemas, the evidence's contract version on every output. Prompts default to `shared/src/prompts.ts` (byte-identical to `SYSTEM_PROMPTS.md` v1.1.0); `endpoint` takes any OpenAI-compatible URL. `backend/scripts/review-run.ts` runs it through `runCommitteeReview` with an append-only local audit file. The measured rehearsal completed real Role/Risk calls; a hosted review schedule is not yet configured. |
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

1. Extend the measured real-provider rehearsal to a cohort that satisfies the
   existing Review gates, then verify Red-Team, freeze and monitoring with that
   cohort. Role/Risk transport, structured output and persisted audit now have
   actual two-model evidence; the tested cohort was rejected before a draft.
2. Run the two-model point-in-time evaluation, select the winner and persist the full
   sanitized prompt/output audit with verified hashes and paper shadow state.
3. Decide whether and where reviews run on a schedule (Vercel Cron or AWS) and store
   the model key as a server-only secret there.
4. Produce the Aggressive LIVE frozen configuration for our account and freeze it
   (`packages/backend/scripts/freeze.ts`, then set `FROZEN_CONFIGURATION_HASH` in both
   services).

## Remaining gates for funded execution

The executor now has a durable write-ahead journal for leverage changes and IOC order
batches. Startup and pre-run recovery detect unresolved journal rows and hold run
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

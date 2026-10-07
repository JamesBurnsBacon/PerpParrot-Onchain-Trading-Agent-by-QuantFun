# Production integration map

Checked against repository code on 2026-10-07. This page describes implemented paths;
it is not a live deployment attestation. Read current status and run evidence to
establish what a particular deployment actually executed.

## Production path

| Stage | Entrypoint and persisted result |
| --- | --- |
| Ingest and Score | `backend/src/pipeline/index.ts`: scan/refresh populate `pipeline_accounts`; qualification and selection call `scoreCandidates`. |
| AI review | Pipeline selection reads positions and fills, measures evidence, calls `openAIPaperCommittee` and `runCommitteeReview`, and writes summaries, model output audit, receipt hash, gate and approved bench into `selection_runs`. |
| Roster and freeze | The roster job applies admission, tenure, exit and exposure rules, then validates and activates a `FrozenConfiguration` in `configurations` when seats change. See [ROSTER.md](../ingest/ROSTER.md). |
| Snapshot and targets | `backend/src/service.ts` stores immutable positions snapshots in `run_snapshots`; `targetsFromSnapshot` (`shared/copy.ts`) derives the targets served at `GET /targets/:runAt`. The same snapshot feeds the paper books. |
| Executor | One long-running process triggers each `:x0`, fetches targets, checks the active/pinned configuration hash and account, claims the run, plans and records results. Vercel hosts dry-run/read endpoints and the watchdog. |
| Dashboard and evidence | Backend pipeline/roster/snapshot/paper endpoints and executor status/runs/equity expose the state. Runs carry `snapshotHash`, `configurationHash` and exposures for reconciliation. |

The root `vercel.json` schedules scan twice daily, refresh every five minutes,
selection at `:x4`, roster at `:x6`, snapshots at `:x9` and the executor watchdog every
five minutes. It does **not** schedule executor `/cron/run`; the long-running executor
owns that trigger. Deployment variables and recovery procedures are in
[DEPLOY.md](../ops/DEPLOY.md) and [RUNBOOK.md](../ops/RUNBOOK.md).

## Review and data boundaries

- The strict review core and the pipeline's default basic gate are distinct. Missing
  strict evidence can reject a core manifest; it does not mean the entire scheduled
  pipeline is unimplemented. See [PIPELINE.md](../ingest/PIPELINE.md#review-gate) for
  `REVIEW_GATE`, measured evidence and approval rules.
- `backend/review/audit.ts` and its `persist_review_audit` RPC support the separate
  [paper lifecycle](PAPER_LIFECYCLE.md). Production pipeline audit is stored in
  `selection_runs.review`; do not use the RPC's status as a proxy for pipeline usage.
- `backend/scripts/review-input.ts`, `review-run.ts` and `freeze.ts` are operator
  entrypoints. The scheduled path calls the shared review components directly.
- NOWNodes routing supports selected backend Info reads, including positions, with
  official-API fallback. Portfolio and fills remain on the official API; executor
  exchange submission is separate. Defaults are official-only. See
  [DEPLOY.md](../ops/DEPLOY.md) for routing switches and `GET /pipeline` metrics.
- Local tests, model responses and a successful deployment do not by themselves prove
  funded execution or predictive edge. Validate a deployed run's time, configuration,
  snapshot hash, dry-run flag and order results. Multi-window strategy evaluation
  remains separate research evidence.

## Deployment and recovery verification

The executor now has a durable write-ahead journal for leverage changes and IOC order
batches. Each run first reconciles unresolved journal rows automatically
(`packages/executor/src/reconcile.ts`), under the cross-process run lock. Every action is
signed with `expiresAfter`, so past that time it has either landed or never will: the run
records Hyperliquid's `orderStatus` per client order ID (`activeAssetData` for leverage) as
evidence and trades against the live account. Before expiry, a row closes only when every
order is final; otherwise that run leaves its perps alone and trades the rest. Nothing pauses
automatically: only a human pauses or flattens. `GET /admin/order-batches` and
`POST /admin/reconcile-batch` remain for manual review.

For a new deployment or funded canary, verify the following against that environment.
This checklist is not a statement that an existing deployment has or has not passed:

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

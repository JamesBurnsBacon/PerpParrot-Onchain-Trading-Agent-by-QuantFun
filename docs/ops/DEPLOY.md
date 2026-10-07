# Deploy (dry run first)

This is a dry-run rehearsal for a new isolated deployment: start with the fixture bootstrap,
then verify the intended account and active roster configuration. Keep `DRY_RUN` unset on every
executor used here. Do not point the rehearsal at an existing production database or alter its
active roster. Existing-production changes use the runbook's backup and recovery procedures.
Reference for variables and failures: [RUNBOOK.md](RUNBOOK.md).

| Phase | Needs | Proves |
|---|---|---|
| A. Services | Supabase, Vercel | the three services build and boot in production mode, tables and policies, both services pin one configuration, a run every 10 minutes plans and signs a dry run, the dashboard reads them |
| B. Go-live set | the frozen go-live set, our HL account | the same, on the real sources and our account |

## Phase A: services

Phase A runs on the **fixture** configuration (`packages/backend/fixtures/frozen-configuration.json`:
7 real sources, AGGRESSIVE, hash `0x088fe80a…e1dd`). Its account `0x010461c1…703a` is a large public
vault standing in for ours; the services only *read* it.

1. **Supabase** (a separate rehearsal project/database): in the SQL editor, apply the files in
   `supabase/migrations/` in order (`20261006130000_review_audit.sql` and
   `20261006140000_paper_review.sql` only once). Don't `supabase db reset` or blindly `db push` this
   database (RUNBOOK § Deploy). Use the session-pooler connection for the executor; the backend
   can use its separate transaction-pooler connection with prepared statements disabled.
2. **Vercel project**: import this repo, **Root Directory = repository root**. The root
   `vercel.json` defines the services `backend` (`/api/backend/*`), `executor` (`/api/executor/*`,
   bound to the backend) and `dashboard` (everything else) and the crons. Variables (one set, both
   services read it):
   ```
   CONFIGURATION_PATH=fixtures/frozen-configuration.json
   FROZEN_CONFIGURATION_HASH=0x088fe80aef2b0d1d58a2e483073105c141fcf4d13ef80f934dfe811c81e6e1dd
   HL_ACCOUNT=0x010461c14e146ac35fe42271bdc1134ee31c703a
   ADMIN_TOKEN=<openssl rand -hex 32; keep it in a password manager>
   CRON_SECRET=<openssl rand -hex 32>
   DATABASE_URL=<service-role connection string>
   BACKEND_DATABASE_URL=<transaction pooler connection string, port 6543>  # backend only; the
   # executor DATABASE_URL stays on the session pooler; check the project's current connection limit
   ```
   Don't set `BACKEND_URL` (the binding injects it), `DRY_RUN`, `HL_API_WALLET_KEY` or the
   `NEXT_PUBLIC_BACKEND_URL` / `NEXT_PUBLIC_EXECUTOR_URL` (the executor runs production rules on Vercel and refuses `DRY_RUN=false`
   there). Optional: `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`. Deploy to **production**: crons only
   run there.
   Optional dashboard demo: `NEXT_PUBLIC_DEMO_VIDEO_URL` accepts an HTTPS YouTube, Vimeo, or
   direct `.mp4`/`.webm` URL. Unset or invalid hides the Demo button. It is baked in at build
   time; rebuild/redeploy after changing it. The video loads only when the modal opens.
3. **Start the run trigger in dry run.** Deploy one long-running executor as described in
   [RUNBOOK.md](RUNBOOK.md), with the same database/account and `DRY_RUN` unset. The current
   Vercel configuration schedules snapshots and watchdogs, not executor runs. For a single
   rehearsal slot, authenticated `/admin/run` is also available.
4. **Check** (exit 0 expected after a completed rehearsal run):
   ```sh
   DATABASE_URL=<…> bun scripts/predeploy-check.ts \
     --configuration packages/backend/fixtures/frozen-configuration.json \
     --backend https://<domain>/api/backend --executor https://<domain>/api/executor --dashboard https://<domain>
   ```
5. **Watch a run**: after the next `:x0`, `GET https://<domain>/api/executor/runs?limit=1` shows a
   `mirror` run, `executed`, `dryRun: true`, with a plan and `evidence.snapshotHash`; the dashboard's
   heartbeat gains a cell, the run log lists it, and the paper books step.

## Phase B: intended account and roster

1. Confirm `HL_ACCOUNT`, the bootstrap file/hash and the intended database before starting
   selection. A file pin is only a fallback when no active database configuration exists.
2. Apply the pipeline/roster migrations and variables described below. Selection produces
   an approved bench; roster admission creates the active configuration.
3. Check `/pipeline.active`, `/pipeline.roster` and the next run's account/configuration evidence.
   When checking a file-managed bootstrap with `predeploy-check.ts`, supply that exact file;
   an old file is not a valid reference for a newer active roster configuration.
4. Watch repeated dry-run cycles. Preserve snapshots and run evidence. Do not truncate a
   production database to remove rehearsal data; use a separate rehearsal database. The
   operator roster fresh-start procedure archives paper history ([ROSTER.md](../ingest/ROSTER.md)).

Going live (`DRY_RUN=false`, API wallet, funding, a long-running executor) is RUNBOOK § Deploy
step 5 and is not part of this rehearsal.

## NOWNodes routing (optional)

The backend can fail over its Hyperliquid info reads to NOWNodes' copy (`hype.nownodes.io/info`). It is off by default; with `INFO_ROUTING` unset or `official` the code path is a plain `fetch` to `api.hyperliquid.xyz`, as before.

| Variable | Meaning |
|---|---|
| `NOWNODES_API_KEY` | Required for anything but `official`. Set it as a Vercel env var with `vercel env add` (never in the repo). |
| `INFO_ROUTING` | `official` (default), `overflow` (a read the official API answers with 429, 5xx or a timeout is retried on NOWNodes), `split` (`INFO_SPLIT_PERCENT`, default 25, of capable reads go to NOWNodes first, failing over to official). |
| `INFO_SHADOW_PERCENT` | Share of official `clearinghouseState` reads also sent to NOWNodes in the background and compared (account value, position count); nothing waits for it. |
| `PICK_OVERLAP_GUARD` | `on` (with `NOWNODES_API_KEY`) makes the 10-minute pick read the top 60 candidates' books, **NOWNodes first** (official API as the fallback), and prefer candidates whose book does not overlap one already chosen by more than the policy's `maxExposureOverlap`. Off by default; see below. |
| `NOWNODES_PROBE` | `on` (with a routing mode other than `official` and a key) probes, in the background and at most every 6 hours per instance, which info methods NOWNodes answers. A method on the allowlist that NOWNodes answers 422 for stops being retried there; nothing is ever added. Off by default. The same probe runs by hand with `NOWNODES_API_KEY=… bun run packages/backend/scripts/probe-nownodes.ts`. |
| `CONTRACT_CHECK` | `on` (with a key) reads `eth_getCode` from NOWNodes' HyperEVM endpoint (`hype.nownodes.io/evm`) for each AI-review pick and records which have code on HyperEVM in the run's `finalists.contracts`; the dashboard marks them. It shows code, not trading: the 7 such addresses checked on 2026-10-07 held no perp positions at that check. Evidence only: it never selects or excludes. A read that fails is "unread", never "not a contract". Off by default. |
| `SNAPSHOT_VERIFY` | `on` or `strict` (with a key) reads every source's positions again from NOWNodes before a mirror snapshot is stored and compares them asset by asset (tolerance `SNAPSHOT_VERIFY_TOLERANCE_PCT`, default 1%, and never less than $5). A difference that survives a re-read of both providers stores nothing and fails the run with a 503, which the executor records and alerts on; the next run rebuilds. If NOWNodes cannot be read, `on` stores the snapshot as usual and `strict` refuses it. `strict` without a key refuses to start rather than running unchecked; a tolerance outside 0-50% falls back to 1%. After a mismatch both providers are read again, and the snapshot is refused unless they agree with each other *and* with what it recorded. Off by default; see below. |

Only `meta`, `perpDexs`, `clearinghouseState`, `spotClearinghouseState`, `webData2`, `userVaultEquities`, `spotMeta` and `vaultSummaries` can go to NOWNodes; `portfolio`, fills and the rest always use the official API (NOWNodes answers 422). The executor is not routed. Three NOWNodes failures in a row pause it for 60 s. `GET /pipeline` returns `routing` (reads, average latency and errors per provider, failovers, shadow matches) and the dashboard's Pipeline panel shows it when NOWNodes is in use.

**Overlap guard.** The pick is Score's top 25. With the guard on, the top 60 are read (about 120 `clearinghouseState` calls, ~2 s in parallel, none of the official API's 1,200 weight/min), the ranking is walked best first, and a candidate whose same-direction overlap (`review/overlap.ts`) with one already chosen is above `maxExposureOverlap` is left out; Score then runs again without the left-out accounts. The pick never shrinks (left-out ones come back in rank order if the pool is short). A single failed read, a paused NOWNodes, or any error leaves Score's own pick, and the guard needs `NOWNODES_API_KEY` (without it nothing runs, so it never turns into a burst on the official API). The run's `finalists.overlapGuard` records what it did and the dashboard shows it. Because a book changes within minutes, turning it on can change the picks more often than today (each change of the 25 triggers an AI review); watch `selection_runs` before leaving it on.

**Provider independence.** With `INFO_ROUTING=split` and `INFO_SPLIT_PERCENT=100`, supported
snapshot reads are NOWNodes-first. Keep `SNAPSHOT_VERIFY` off in that setup: its second
reader is also NOWNodes, so a successful comparison is not independent-provider evidence.
The existing fallback, configuration validation and snapshot hashing still apply.

**Snapshot cross-check.** `SNAPSHOT_VERIFY` adds a second delivery path to the same Hyperliquid state: it catches a stale or partial answer from one provider before the executor sizes orders from it. It cannot catch an error Hyperliquid itself makes, and it only compares what NOWNodes serves (`clearinghouseState`: positions), not `portfolio` equity. The outcome is not written into the snapshot (the snapshot's bytes are hashed and never change); `GET /pipeline` returns `verification` (checks, verified, blocked, unverified, the last result) from the instance that answers, so on Vercel the counters are per instance. A run the check blocks also skips that run's paper-book step, because no snapshot is stored.

**Try the cross-check on live data before turning it on.** `NOWNODES_API_KEY=… bun run packages/backend/scripts/verify-live-dryrun.ts` reads the fixture's sources from the official API, checks them against NOWNodes (expected: verified), then checks a doctored copy (expected: mismatch). Read-only; exit 0 only when both come out as expected. One run is one moment in time.

**Try the failover without touching anything.** `bun run packages/backend/scripts/chaos-read-demo.ts` runs the real router twice over a simulated network in which the official API answers 429 for part of the run, once with the default routing and once with `overflow`, and prints the failed reads, failovers and virtual latency of each. It uses no key and no network.

Choose routing for the intended workload. `overflow` preserves official-first reads; `split`
with `INFO_SPLIT_PERCENT=100` uses NOWNodes first for supported methods. Local October 7
benchmarks found NOWNodes slower per request, not faster; this is a capacity/provider-diversity
choice. Measure deployment latency separately (see README §5). Snapshot callers time out the
first read after 15 s; pipeline callers use 20 s. Fallback has a separate 15 s timeout, subject
to the caller signal. Fast HTTP errors can fall back sooner. These are timeout budgets, not an SLA.

## Turning the NOWNodes features on (checklist)

Every NOWNodes feature is off by default: with its variables unset the code is the path from before NOWNodes. Before assuming what a deployment runs, look at its real configuration (`vercel env ls production`). Nothing needs doing until someone decides to switch a feature on, and in a shared environment that is agreed first. The order below goes from "cannot touch trading" to "can stop a run". The executor is never routed through NOWNodes, whatever is set.

**Before setting anything** (read-only, no deploy). Give the key to the two commands through a hidden prompt, so it does not land in the shell history, a PR or a chat:

```bash
printf 'NOWNodes key: '; read -rs NOWNODES_API_KEY; echo; export NOWNODES_API_KEY
bun run packages/backend/scripts/probe-nownodes.ts        # exits 0 when the allowlist and NOWNodes agree
bun run packages/backend/scripts/verify-live-dryrun.ts    # prints OK when a live snapshot verifies and a doctored copy does not
unset NOWNODES_API_KEY
```

**Setting a variable:** on the Vercel project the backend deploys from, `vercel env add <NAME> production` (it prompts for the value; use the prompt for the key), then redeploy: a variable takes effect with the next deployment. Check on `GET /api/backend/pipeline`. All of these need `NOWNODES_API_KEY`; step 2 needs `INFO_ROUTING=overflow` or `split` (the probe does not run in `official` mode).

| Step | Set | What it can do to trading | What to see afterwards |
|---|---|---|---|
| 1 | `NOWNODES_API_KEY`, `INFO_ROUTING=overflow` | Changes where a read comes from only after the official API fails it (429, 5xx, timeout); while the official API answers, nothing. | `routing.mode` is `overflow`; `routing.nownodes.requests` stays 0 until the official API fails. |
| 2 | `NOWNODES_PROBE=on` | Can stop retrying a method NOWNodes refuses (never adds one). | `routing.capabilities` appears after the first routed read; `narrowed` is `[]`. |
| 3 | `CONTRACT_CHECK=on` | Nothing; evidence only. | After the next AI review, `latest.finalists.contracts` is present and the finalist table marks contracts. |
| 4 | `SNAPSHOT_VERIFY=on` | **Can stop a run**: a confirmed mismatch stores no snapshot and the executor records a failed run. With NOWNodes unreadable it still stores the snapshot (so use `on`; `strict` would refuse it, and refuses to start without a key). | `verification.verified` grows with each snapshot and `verification.unverified` stays 0 (a growing `unverified` means NOWNodes could not be read and nothing was compared); `verification.mismatches` stays 0. `verification.mode` reads `off` until the first check has run. |
| 5 | `PICK_OVERLAP_GUARD=on` | **Can change the picks**, and so trigger more AI reviews. Not part of the default recommendation. | `latest.finalists.overlapGuard`. |

**NOWNodes-first profile:** set `INFO_ROUTING=split`, `INFO_SPLIT_PERCENT=100` and optionally
`NOWNODES_PROBE=on`, with the key configured privately. Keep `SNAPSHOT_VERIFY` off; do not
combine the official-first cross-check checklist with this profile. `SNAPSHOT_VERIFY=strict`
can block snapshots during a provider outage. Choose that behavior explicitly, not as a default.

**Undo:** remove a feature's own variable (`vercel env rm <NAME> production`) and redeploy; that changes only that feature. Remove the feature variables before `NOWNODES_API_KEY`. `routing.mode` returns to `official` only once `INFO_ROUTING` is removed; `verification` stops growing once `SNAPSHOT_VERIFY` is removed. Picks the overlap guard already changed are not reverted: the next scoring just stops using it.

<a id="selection-pipeline"></a>

## Selection pipeline (2026-10-07; [docs/ingest/PIPELINE.md](../ingest/PIPELINE.md))

Every 12 hours (00:15 and 12:15 UTC) the backend scans every leaderboard trader (≥ $10k, positive
month and all-time PnL) and HyperCore vault (hyperliquidvaults.com's list first, then
Hyperliquid's: open, not a child, ≥ $10k, ≥ 39 days old), about 14k accounts. The refresh
(every 5 minutes, 900 weight/min) keeps their portfolios within 12 hours and reads the
qualified accounts' portfolio and fills every hour, three reads at a time. Primary sources
(hyperliquidvaults.com's vaults, the leaderboard's top 200) are read first. Once they are fresh
and 95% of a scan is (or 3.5 hours after the scan), Score qualifies its top 250. Every 10 minutes Score picks 25 from the qualified list, leaving out
high-frequency traders (>100 orders a day). The AI committee reviews changed picks or refreshes
approvals at least every 12 h. Its results populate the bench. The separate roster job admits and
reviews seats, freezes a configuration for `HL_ACCOUNT`, and activates it when seats, weights or
policy differ (otherwise `kept`). The backend and executor use that active hash.

**Basic gate (default):** the AI review sees measured evidence for each finalist (hold time,
leverage, trailing holdouts, execution fit, exposure overlap; docs/ingest/PIPELINE.md "Review
gate"). A VALID manifest uses strict approvals. Only `INSUFFICIENT_EVIDENCE` allows the basic
fallback: candidates not rejected by Role, with no disqualifying Risk score (evidence risk aside)
and positive fit. `POLICY_VIOLATION` and other invalid reasons approve nobody. The bench then
passes through copyability, tenure, pacing and fixed-seat weighting in the roster. At least five
seats are needed to activate a configuration. `REVIEW_GATE=strict` disables the basic fallback.

1. **Supabase**: run `supabase/migrations/20261007120000_pipeline.sql`, then
   `20261007150000_pipeline_qualified.sql` and `20261007160000_pipeline_primary.sql`, **before**
   the deploy. `20261008010000_run_targets.sql` adds the target history; until it runs, each run
   alerts "target history not saved" and otherwise trades as before. `20261008020000_roster.sql`
   adds the roster (`roster_seats`, `roster_events`, status `benched`) and must run **before** the
   roster deploy: until then `/cron/pipeline/roster` fails and reviews can't save their bench.
   `20261008030000_roster_leverage.sql` adds each seat's average leverage (the normalization) and must
   run **before** that deploy: until then admissions fail. Both only add tables, columns
   and a wider status check, and are safe to run twice. The new code reads the new columns, so
   until they exist the pipeline routes fail.
2. **Vercel variables**:
   - `HL_ACCOUNT` = our account (`0x7269502c48c582768ee38e4e71e7572e6ebf70f7`).
   - `DRY_RUN_EQUITY_USD=10000`.
   - `OPENAI_API_KEY` supplied privately; verify it in the intended deployment.
3. **Merge** and wait for Ready. Watch `GET /api/backend/pipeline`:
   - qualification waits for primary sources plus 95% of the scan, or the 3.5-hour cold-start
     allowance; actual completion depends on API availability and budget;
   - fresh qualified fills allow `:x4` selection/review; inspect the bench and gate;
   - `:x6` roster admission/activation updates `active`; the long-running executor's next
     `:x0` consumes it in dry run.
4. **Operator**: `POST /api/backend/admin/pipeline/scan|refresh|select|roster` with
   `Authorization: Bearer $ADMIN_TOKEN`. An operator's `select` qualifies on partial data and
   reviews an unchanged pick.

## Upgrading a deployment from before 2026-10-07 (Chainlink CRE removed)

The executor no longer receives signed reports: it runs the backend's targets itself, and some
tables and columns were renamed. This section applies only to a database still using that legacy schema;
it is historical migration guidance, not the current runtime design:

1. As soon as the new production deployment is Ready, run
   `supabase/migrations/20261007090000_rename_mirror_tables.sql` in the SQL editor (renames
   `cre_snapshots` → `run_snapshots`, `cre_eligibility` → `eligibility_state`, `executor_reports` →
   `executor_run_claims`, `executor_runs.envelope` → `evidence`, `report_id` → `run_id`, run kind
   `report` → `mirror`; safe to run twice). Until it runs, the new code's database reads fail and
   runs are recorded as failed; nothing trades either way in dry run.
2. Remove the old variables if they are set: `WORKFLOW_OWNER`, `VERIFY_REPORTS`,
   `ETH_MAINNET_RPC_URL`, `WORKFLOW_NAME`, `DON_ID`, `MAX_REPORT_LEAD_SECONDS`,
   `MAX_REPORT_TTL_SECONDS`.
3. Verify cron jobs match the current root `vercel.json` (no executor `/cron/run` job),
   verify the long-running executor's timer, and inspect a subsequent run's evidence.

## Undo

Before a rollout, retain the prior deployment URL/revision and private environment backup.
For read routing, set `INFO_ROUTING=official` and redeploy to restore official-first reads;
disable independent optional features separately. To stop live trading, pause the long-running
executor (`POST /admin/pause`); runs remain recorded. A Vercel rollback does not roll back the
Railway executor or the active database configuration. Preserve tables and evidence; use the
runbook for operator recovery instead of deleting the project or truncating production state.

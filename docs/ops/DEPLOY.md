# Deploy (dry run first)

Deploys every piece in its production shape on the **fixture** configuration, then swaps in the
real frozen set and our account. Nothing here sends an order: `DRY_RUN` stays unset throughout.
Reference for variables and failures: [RUNBOOK.md](RUNBOOK.md).

| Phase | Needs | Proves |
|---|---|---|
| A. Services | Supabase, Vercel | the three services build and boot in production mode, tables and policies, both services pin one configuration, a run every 10 minutes plans and signs a dry run, the dashboard reads them |
| B. Go-live set | the frozen go-live set, our HL account | the same, on the real sources and our account |

## Phase A: services

Phase A runs on the **fixture** configuration (`packages/backend/fixtures/frozen-configuration.json`:
7 real sources, AGGRESSIVE, hash `0x088fe80a…e1dd`). Its account `0x010461c1…703a` is a large public
vault standing in for ours; the services only *read* it.

1. **Supabase** (project `clheeepphmomkymawsfq`): in the SQL editor, run the files in
   `supabase/migrations/` in order (`20261006130000_review_audit.sql` and
   `20261006140000_paper_review.sql` only once). Don't `supabase db reset` or blindly `db push` this
   project (RUNBOOK § Deploy). Copy the service-role connection string (Session pooler, not the
   transaction pooler: Bun's driver prepares statements) for step 2.
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
   ```
   Don't set `BACKEND_URL` (the binding injects it), `DRY_RUN`, `HL_API_WALLET_KEY` or the
   `NEXT_PUBLIC_*` URLs (the executor runs production rules on Vercel and refuses `DRY_RUN=false`
   there). Optional: `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`. Deploy to **production**: crons only
   run there.
3. **Check** (exit 0 expected):
   ```sh
   DATABASE_URL=<…> bun scripts/predeploy-check.ts \
     --configuration packages/backend/fixtures/frozen-configuration.json \
     --backend https://<domain>/api/backend --executor https://<domain>/api/executor --dashboard https://<domain>
   ```
4. **Watch a run**: after the next `:x0`, `GET https://<domain>/api/executor/runs?limit=1` shows a
   `mirror` run, `executed`, `dryRun: true`, with a plan and `evidence.snapshotHash`; the dashboard's
   heartbeat gains a cell, the run log lists it, and the paper books step.

## Phase B: go-live set (when the set is frozen)

1. **Freeze** the review's configuration for our account (RUNBOOK § Freeze). This writes
   `packages/backend/frozen/live.json`.
2. **Reset rehearsal data** (it was computed on the stand-in account and the fixture set):
   ```sql
   truncate paper_state, paper_points, run_snapshots, eligibility_state;
   ```
3. **Vercel variables**: `CONFIGURATION_PATH=frozen/live.json`, the new
   `FROZEN_CONFIGURATION_HASH` and `HL_ACCOUNT` = our account; redeploy.
4. **Check**: `predeploy-check.ts` (without `--configuration`) must exit 0.
5. **Watch** two or three cycles in the run log.

Going live (`DRY_RUN=false`, API wallet, funding, a long-running executor) is RUNBOOK § Deploy
step 5 and is not part of this rehearsal.

## NOWNodes failover (optional)

The backend can fail over its Hyperliquid info reads to NOWNodes' copy (`hype.nownodes.io/info`). It is off by default; with `INFO_ROUTING` unset or `official` the code path is a plain `fetch` to `api.hyperliquid.xyz`, as before.

| Variable | Meaning |
|---|---|
| `NOWNODES_API_KEY` | Required for anything but `official`. Set it as a Vercel env var with `vercel env add` (never in the repo). |
| `INFO_ROUTING` | `official` (default), `overflow` (a read the official API answers with 429, 5xx or a timeout is retried on NOWNodes), `split` (`INFO_SPLIT_PERCENT`, default 25, of capable reads go to NOWNodes first, failing over to official). |
| `INFO_SHADOW_PERCENT` | Share of official `clearinghouseState` reads also sent to NOWNodes in the background and compared (account value, position count); nothing waits for it. |

Only `meta`, `perpDexs`, `clearinghouseState`, `spotClearinghouseState`, `webData2`, `userVaultEquities`, `spotMeta` and `vaultSummaries` can go to NOWNodes; `portfolio`, fills and the rest always use the official API (NOWNodes answers 422). The executor is not routed. Three NOWNodes failures in a row pause it for 60 s. `GET /pipeline` returns `routing` (reads, average latency and errors per provider, failovers, shadow matches) and the dashboard's Pipeline panel shows it when NOWNodes is in use.

`split` is slower (NOWNodes measured about 1.7x the official latency), so prefer `overflow` unless a benchmark says otherwise.

## Selection pipeline (2026-10-07; [docs/ingest/PIPELINE.md](../ingest/PIPELINE.md))

Every 12 hours (00:15 and 12:15 UTC) the backend scans every leaderboard trader (≥ $10k, positive
month and all-time PnL) and HyperCore vault (hyperliquidvaults.com's list first, then
Hyperliquid's: open, not a child, ≥ $10k, ≥ 39 days old), about 14k accounts. The refresh
(every 5 minutes, 900 weight/min) keeps their portfolios within 12 hours and reads the
qualified accounts' portfolio and fills every hour. Once 95% of a scan is refreshed, Score
qualifies its top 250. Every 10 minutes Score picks 25 from the qualified list, leaving out
high-frequency traders (> 100 orders a day). When the 25 change, the AI committee reviews them;
the result is frozen for `HL_ACCOUNT` and activated if its sources differ from the active set's
(otherwise the run is `kept`). The backend serves the active configuration and the executor
checks targets against its hash.

**Basic gate (default):** the review core can't pass anyone yet, because the frame has no
measured out-of-sample or execution evidence. When it rejects, the pipeline keeps finalists the
Role model doesn't reject and that have no Risk score above the reject threshold (evidence risk
aside). It weights them by Aggressive fit, within the per-source cap, cash buffer and gross
leverage, and needs at least 5. `REVIEW_GATE=strict` turns this off.

1. **Supabase**: run `supabase/migrations/20261007120000_pipeline.sql`, then
   `20261007150000_pipeline_qualified.sql`, **before** the deploy. Both only add tables, columns
   and a wider status check, and are safe to run twice. The new code reads the new columns, so
   until they exist the pipeline routes fail.
2. **Vercel variables**:
   - `HL_ACCOUNT` = our account (`0x7269502c48c582768ee38e4e71e7572e6ebf70f7`).
   - `DRY_RUN_EQUITY_USD=10000`.
   - `OPENAI_API_KEY` (already set).
3. **Merge** and wait for Ready. Watch `GET /api/backend/pipeline`:
   - `accounts.qualified` appears once the latest scan is 95% refreshed: from a 200-account
     list right away, from a full 14k scan after ~8 hours;
   - the qualified accounts' fills are read within about an hour, then the next `:x4` run picks
     25 and reviews them, and `active` shows the sources;
   - the next `:x0` run trades toward them (dry run).
4. **Operator**: `POST /api/backend/admin/pipeline/scan|refresh|select` with
   `Authorization: Bearer $ADMIN_TOKEN`. An operator's `select` qualifies on partial data and
   reviews an unchanged pick.

## Upgrading a deployment from before 2026-10-07 (Chainlink CRE removed)

The executor no longer receives signed reports: it runs the backend's targets itself, and some
tables and columns were renamed. When the change reaches `main` (and production redeploys):

1. As soon as the new production deployment is Ready, run
   `supabase/migrations/20261007090000_rename_mirror_tables.sql` in the SQL editor (renames
   `cre_snapshots` → `run_snapshots`, `cre_eligibility` → `eligibility_state`, `executor_reports` →
   `executor_run_claims`, `executor_runs.envelope` → `evidence`, `report_id` → `run_id`, run kind
   `report` → `mirror`; safe to run twice). Until it runs, the new code's database reads fail and
   runs are recorded as failed; nothing trades either way in dry run.
2. Remove the old variables if they are set: `WORKFLOW_OWNER`, `VERIFY_REPORTS`,
   `ETH_MAINNET_RPC_URL`, `WORKFLOW_NAME`, `DON_ID`, `MAX_REPORT_LEAD_SECONDS`,
   `MAX_REPORT_TTL_SECONDS`.
3. Check Vercel → Settings → Cron Jobs lists `/api/executor/cron/run`, then run
   `predeploy-check.ts` after the next `:x0`.

## Undo

Vercel: remove the project. Supabase: the tables are only read by these services; `truncate` them
or leave them. To stop trading without undeploying, pause the executor (`POST /admin/pause`): runs
are still recorded but send nothing.

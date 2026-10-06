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

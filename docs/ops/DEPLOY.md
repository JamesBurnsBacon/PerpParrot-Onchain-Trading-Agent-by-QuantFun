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
   BACKEND_DATABASE_URL=<transaction pooler connection string, port 6543>  # backend only; the
   # session pooler (DATABASE_URL) allows 15 clients in all, and the executor's run lock needs it
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
| `PICK_OVERLAP_GUARD` | `on` (with `NOWNODES_API_KEY`) makes the 10-minute pick read the top 60 candidates' books, **NOWNodes first** (official API as the fallback), and prefer candidates whose book does not overlap one already chosen by more than the policy's `maxExposureOverlap`. Off by default; see below. |
| `NOWNODES_PROBE` | `on` (with a routing mode other than `official` and a key) probes, in the background and at most every 6 hours per instance, which info methods NOWNodes answers. A method on the allowlist that NOWNodes answers 422 for stops being retried there; nothing is ever added. Off by default. The same probe runs by hand with `NOWNODES_API_KEY=… bun run packages/backend/scripts/probe-nownodes.ts`. |
| `CONTRACT_CHECK` | `on` (with a key) reads `eth_getCode` from NOWNodes' HyperEVM endpoint (`hype.nownodes.io/evm`) for each AI-review pick and records which are contracts (an ERC-4626 vault, a router, a protocol account: not a person's wallet) in the run's `finalists.contracts`; the dashboard marks them. Evidence only: it never selects or excludes. A read that fails is "unread", never "not a contract". Off by default. |
| `SNAPSHOT_VERIFY` | `on` or `strict` (with a key) reads every source's positions again from NOWNodes before a mirror snapshot is stored and compares them asset by asset (tolerance `SNAPSHOT_VERIFY_TOLERANCE_PCT`, default 1%, and never less than $5). A difference that survives a re-read of both providers stores nothing and fails the run with a 503, which the executor records and alerts on; the next run rebuilds. If NOWNodes cannot be read, `on` stores the snapshot as usual and `strict` refuses it. `strict` without a key refuses to start rather than running unchecked; a tolerance outside 0-50% falls back to 1%. After a mismatch both providers are read again, and the snapshot is refused unless they agree with each other *and* with what it recorded. Off by default; see below. |

Only `meta`, `perpDexs`, `clearinghouseState`, `spotClearinghouseState`, `webData2`, `userVaultEquities`, `spotMeta` and `vaultSummaries` can go to NOWNodes; `portfolio`, fills and the rest always use the official API (NOWNodes answers 422). The executor is not routed. Three NOWNodes failures in a row pause it for 60 s. `GET /pipeline` returns `routing` (reads, average latency and errors per provider, failovers, shadow matches) and the dashboard's Pipeline panel shows it when NOWNodes is in use.

**Overlap guard.** The pick is Score's top 25. With the guard on, the top 60 are read (about 120 `clearinghouseState` calls, ~2 s in parallel, none of the official API's 1,200 weight/min), the ranking is walked best first, and a candidate whose same-direction overlap (`review/overlap.ts`) with one already chosen is above `maxExposureOverlap` is left out; Score then runs again without the left-out accounts. The pick never shrinks (left-out ones come back in rank order if the pool is short). A single failed read, a paused NOWNodes, or any error leaves Score's own pick, and the guard needs `NOWNODES_API_KEY` (without it nothing runs, so it never turns into a burst on the official API). The run's `finalists.overlapGuard` records what it did and the dashboard shows it. Because a book changes within minutes, turning it on can change the picks more often than today (each change of the 25 triggers an AI review); watch `selection_runs` before leaving it on.

**Snapshot cross-check.** `SNAPSHOT_VERIFY` adds a second delivery path to the same Hyperliquid state: it catches a stale or partial answer from one provider before the executor sizes orders from it. It cannot catch an error Hyperliquid itself makes, and it only compares what NOWNodes serves (`clearinghouseState`: positions), not `portfolio` equity. The outcome is not written into the snapshot (the snapshot's bytes are hashed and never change); `GET /pipeline` returns `verification` (checks, verified, blocked, unverified, the last result) from the instance that answers, so on Vercel the counters are per instance. A run the check blocks also skips that run's paper-book step, because no snapshot is stored.

**Try the cross-check on live data before turning it on.** `NOWNODES_API_KEY=… bun run packages/backend/scripts/verify-live-dryrun.ts` reads the fixture's sources from the official API, checks them against NOWNodes (expected: verified), then checks a doctored copy (expected: mismatch). Read-only; exit 0 only when both come out as expected. One run is one moment in time.

**Try the failover without touching anything.** `bun run packages/backend/scripts/chaos-read-demo.ts` runs the real router twice over a simulated network in which the official API answers 429 for part of the run, once with the default routing and once with `overflow`, and prints the failed reads, failovers and virtual latency of each. It uses no key and no network.

`split` is slower (NOWNodes measured about 1.7x the official latency), so prefer `overflow` unless a benchmark says otherwise.

## Selection pipeline (2026-10-07; [docs/ingest/PIPELINE.md](../ingest/PIPELINE.md))

Every 12 hours (00:15 and 12:15 UTC) the backend scans every leaderboard trader (≥ $10k, positive
month and all-time PnL) and HyperCore vault (hyperliquidvaults.com's list first, then
Hyperliquid's: open, not a child, ≥ $10k, ≥ 39 days old), about 14k accounts. The refresh
(every 5 minutes, 900 weight/min) keeps their portfolios within 12 hours and reads the
qualified accounts' portfolio and fills every hour, three reads at a time. Primary sources
(hyperliquidvaults.com's vaults, the leaderboard's top 200) are read first. Once they are fresh
and 95% of a scan is (or 3.5 hours after the scan), Score qualifies its top 250. Every 10 minutes Score picks 25 from the qualified list, leaving out
high-frequency traders (> 100 orders a day). When the 25 change, the AI committee reviews them;
the result is frozen for `HL_ACCOUNT` and activated if its sources differ from the active set's
(otherwise the run is `kept`). The backend serves the active configuration and the executor
checks targets against its hash.

**Basic gate (default):** the AI review sees measured evidence for each finalist (hold time,
leverage, trailing holdouts, execution fit, exposure overlap; docs/ingest/PIPELINE.md "Review
gate"), but its strict rules rarely keep the 5 sources a freeze needs. When it rejects, the pipeline keeps finalists the
Role model doesn't reject and that have no Risk score above the reject threshold (evidence risk
aside). It weights them by Aggressive fit, within the per-source cap, cash buffer and gross
leverage, and needs at least 5. `REVIEW_GATE=strict` turns this off.

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

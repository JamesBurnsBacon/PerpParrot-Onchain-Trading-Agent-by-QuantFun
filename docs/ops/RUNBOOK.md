# Mirror runbook

How to run, deploy, freeze and stop the live copy-trading path: every 10 minutes the backend reads
the frozen sources' positions and turns them into target exposures, and the executor trades toward
them. Design: README §4.7, §4.8, §4.13, §4.14. There is no Chainlink CRE (removed 2026-10-07).

## Pieces

| Piece | Code | Runs on | Talks to |
|---|---|---|---|
| Backend (snapshots, targets, paper books) | `packages/backend` (`src/server.ts`) | Vercel service `backend`, `/api/backend/*` | HL Info API, NOWNodes (configured supported reads), Supabase |
| Executor | `packages/executor` (`src/server.ts`) | Vercel service `executor`, `/api/executor/*` (dry run only); one long-running process for live | backend (service binding `BACKEND_URL`), HL Info + Exchange API, Supabase, Telegram |
| Dashboard | `packages/dashboard` (Next.js) | Vercel service `dashboard`, every other path | backend, executor (browser fetches on the same origin, read-only) |
| Tables | `supabase/migrations/` | Supabase | — |

All three deploy as one Vercel project from the root `vercel.json` (one domain, one deployment).
On Vercel the two Bun services run as functions that stop between requests, so the schedule is
Vercel Cron: `/api/backend/cron/snapshot` at `:x9` builds the coming run's snapshot,
and `/api/executor/cron/watchdog` every 5 minutes alerts on missed runs. Selection and roster
also run on Vercel Cron (see [PIPELINE.md](../ingest/PIPELINE.md)). Executor `/cron/run` is not
scheduled in the root configuration. One long-running executor triggers `:x0` with its timer,
including during a dry-run rehearsal; an authenticated operator can trigger a slot manually. Both
services also answer on their bare paths (`/health`, `/targets/…`), which is what local runs,
Docker and the e2e script use.

## Run it locally

Use Bun 1.4.2 (the CI version) and network access. The E2E script forces dry run.
Use an isolated environment without production database, API-wallet or alert credentials;
Bun can load local `.env` files. Any `DATABASE_URL` below must be a disposable test database.

```sh
./scripts/e2e-mirror.sh          # backend + executor, one run for the next :x0 (dry run), checks the result
./scripts/e2e-mirror.sh all      # also: paused, backend down, wrong configuration, duplicate trigger
DATABASE_URL=postgres://… ./scripts/e2e-mirror.sh   # same, with both services on Postgres
```

A run for a given slot can also be started by hand on any executor:
`curl -X POST -H "Authorization: Bearer $ADMIN_TOKEN" -d '{"runAt": <unix seconds, a :x0>}' $EXECUTOR/admin/run`.
The backend only builds a snapshot within `SNAPSHOT_MAX_LEAD_SECONDS` (120) of its run time; the
e2e script sets 600 so it can ask for the next `:x0` early.

Unit tests per package: `bun test` in `packages/backend` and `packages/executor`; the review core
and migrations: `pnpm test` at the root. Postgres integration tests run when `TEST_DATABASE_URL`
is set (see `packages/executor/test/pg-store.test.ts`).

## Environment

### Backend (`packages/backend`)

| Variable | Required | Meaning |
|---|---|---|
| `CONFIGURATION_PATH` | yes | Frozen configuration JSON (the freeze output), relative to `packages/backend` |
| `FROZEN_CONFIGURATION_HASH` | yes | Hash of the bootstrap file; once present, a validated active Supabase configuration takes precedence |
| `DATABASE_URL` | prod | Supabase Postgres session connection; snapshots/eligibility otherwise use memory. Required on Vercel unless `BACKEND_DATABASE_URL` supplies the backend connection |
| `BACKEND_DATABASE_URL` | no | Backend-only transaction pooler (6543), with prepared statements disabled; takes precedence over `DATABASE_URL` |
| `CRON_SECRET` | Vercel | Vercel Cron sends it to `/cron/snapshot`; required on Vercel (any random string, shared with the executor) |
| `SNAPSHOT_MAX_LEAD_SECONDS` | no | How close to a run a snapshot may be built (default 120). `600` only for local end-to-end runs |
| `PAPER_BALANCED_MULTIPLIER` | no | Balanced book = Aggressive weights × this (default 0.5) |
| `PAPER_SLIPPAGE_BPS` | no | Paper fills at mark ± this (default 5) |
| `ARTIFACTS_DIR` | no | Without `DATABASE_URL`: folder of `backtest.json` / `funnel.json` for the dashboard (default `artifacts`) |
| `PORT` | no | Local and Docker only (default 8788) |

### Executor (`packages/executor`)

| Variable | Required | Default | Meaning |
|---|---|---|---|
| `HL_ACCOUNT` | yes | — | Our HL master account (must equal the configuration's `account`) |
| `FROZEN_CONFIGURATION_HASH` | yes | — | Bootstrap pin; the executor checks the active database configuration hash when available, otherwise this pin |
| `BACKEND_URL` | prod | `http://localhost:8788` | The backend's base URL. On Vercel the service binding injects it (`vercel.json`); set it yourself on a long-running host |
| `NODE_ENV` | prod | — | `production` requires `ADMIN_TOKEN`, `DATABASE_URL` and `BACKEND_URL`. Every Vercel deployment (previews too) counts as production |
| `CRON_SECRET` | Vercel | — | Protects cron endpoints; root `vercel.json` schedules `/cron/watchdog` only for the executor |
| `ADMIN_TOKEN` | prod | — | Bearer token for `/admin/*` |
| `DRY_RUN` | no | `true` | Only the literal `false` sends orders; refused on Vercel |
| `HL_API_WALLET_KEY` | live | — | API wallet (agent) key: trades, can't withdraw. Required when `DRY_RUN=false` |
| `DATABASE_URL` | prod | — | Supabase Postgres, **session pooler** (port 5432: the run lock needs a session). Without it run claims, runs and the kill switch are in memory |
| `EXECUTOR_READ_DATABASE_URL` | no | — | Supabase's **transaction pooler** (port 6543) for the dashboard's reads (`/status`, `/runs`, `/equity`) and the watchdog, so they don't use up the session pooler's 20 connections. Unset: they share `DATABASE_URL` |
| `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID` | no | — | Alerts; without them alerts are logged only |
| `SLIPPAGE_BPS` | no | `50` | IOC limit = mark ± this |
| `MIN_ORDER_USD` / `DRIFT_FRACTION` / `MARGIN_CAP` | no | `10` / `0.1` / `0.95` | README §4.4, §4.8 |
| `EQUITY_BAND_FRACTION` | no | `0.005` | A leg trades only if its gap is also ≥ this share of equity (README §4.4; the paper books use `PAPER_EQUITY_BAND_FRACTION`, same default) |
| `MAX_GROSS_LEVERAGE` | no | `10` | Sanity bound: reject targets whose gross exposure exceeds this |
| `RUN_TTL_SECONDS` | no | `300` | Orders for a run may go out until `runAt` + this |
| `RUN_TIMEOUT_SECONDS` | no | `60` | A run still going after this is alerted on and stops before its next order batch; the next run waits for it to finish |
| `MISSED_RUN_ALERT_MINUTES` | no | `25` | Alert after this long without a finished run |

### Dashboard (`packages/dashboard`, Vercel)

| Variable | Meaning |
|---|---|
| `NEXT_PUBLIC_BACKEND_URL` | Optional. Backend URL (no trailing slash); default `/api/backend` (same origin) |
| `NEXT_PUBLIC_EXECUTOR_URL` | Optional. Executor URL; default `/api/executor` |

Leave both unset on Vercel. If set, they are baked in at build time: redeploy after changing them.
Locally, `next dev` on its own proxies `/api/backend` and `/api/executor` to `localhost:8788` /
`localhost:8787` (`bun run dev` in each package; `?theme=light|dark` pins a mode), and `vercel dev`
at the repository root runs all three services behind one port.

## Deploy

Before and after each step, `bun scripts/predeploy-check.ts --backend https://<domain>/api/backend
--executor https://<domain>/api/executor [--dashboard https://<domain>]` (with `DATABASE_URL=…` to
include Supabase) checks that `frozen/live.json`, both services and the tables agree, and that runs
arrive. Read-only; exit 1 on any failure. `--configuration <file>` compares against another
configuration (e.g. the fixture before the go-live freeze). First-time setup, step by step:
[DEPLOY.md](DEPLOY.md).

1. **Supabase:** project `PerpParrot` (ref `clheeepphmomkymawsfq`). Run the files in
   `supabase/migrations/` in order in the SQL editor (they are idempotent except
   `20261006130000_review_audit.sql` and `20261006140000_paper_review.sql`, which run once). A
   database created before 2026-10-07 also needs `20261007090000_rename_mirror_tables.sql` (renames
   the old `cre_*` / `executor_reports` tables; safe to re-run). Don't `supabase db reset` or blindly
   `db push` this project: some migrations were applied by hand outside CLI history.
2. **Vercel:** one project from this repo, **Root Directory = repository root** (the root
   `vercel.json` defines the three services, their routes, the executor's binding to the backend
   and the crons). Set the variables above once for the project (`DATABASE_URL`, `CRON_SECRET`,
   `FROZEN_CONFIGURATION_HASH` and `HL_ACCOUNT` serve both services), with `DRY_RUN` unset. Use the
   Supabase **Session pooler** connection string for `DATABASE_URL`: the executor's run lock is a
   session-level advisory lock. Set `BACKEND_DATABASE_URL` to the **Transaction pooler** string
   (port 6543): the backend then uses it with `prepare: false`, so its crons and dashboard reads
   don't use up the session pooler's 20 connections. Deploy to production (crons only run on
   production deployments). Vercel may run several executor instances; each run takes a Postgres
   advisory lock and a per-run claim, so a run never happens twice or overlaps another.
3. **Check:** `GET https://<domain>/api/executor/status` (dry run, `store: postgres`). Start the
   long-running executor in dry run, or trigger a current slot through authenticated `/admin/run`.
   Then inspect `/api/executor/runs?limit=3`: a `mirror` run with `status: "executed"`,
   `dryRun: true`, a reviewed plan and `evidence.snapshotHash`. Vercel alone does not schedule runs.
4. **Dashboard:** deployed with the other two at `https://<domain>/`; the header should read
   "Dry run · Copying" and the heartbeat gains a cell every 10 minutes.
5. **Go live:**
   1. Move the executor to one long-running process. It refuses `DRY_RUN=false` on Vercel:
      Vercel may run several instances at once and stops them between requests, while live
      trading needs one HL nonce sequence and one run queue (README §4.8). The Dockerfile and
      `packages/executor/railway.json` build that process (one replica, `/health`):
      1. Create a Railway service from this repo with those files. Variables: `DATABASE_URL`
         (session pooler), `BACKEND_URL=https://<domain>/api/backend`, `HL_ACCOUNT`,
         `FROZEN_CONFIGURATION_HASH`, `ADMIN_TOKEN`, and `TELEGRAM_BOT_TOKEN`/`TELEGRAM_CHAT_ID`
         for alerts. No `DRY_RUN` and no `DRY_RUN_EQUITY_USD` (it sizes dry runs only).
         `MAX_GROSS_LEVERAGE` is the raw-gross backstop (default 10×). Under the 5× counted-gross
         cap, equal long/short exposure can reach about 6.67× raw gross. Keep the reviewed
         deployment setting; changing this threshold is a policy change. Its pool
         keeps 4 of the session pooler's 20 connections. `EXECUTOR_READ_DATABASE_URL` isn't needed
         there: the dashboard reads through the Vercel executor.
      2. Deploy it still in dry run; `GET /status` on Railway shows `dryRun: true`.
      3. Verify deployed cron configuration still omits `/api/executor/cron/run`, as the current
         root `vercel.json` does. A second scheduled executor could claim a live slot first.
         Vercel keeps read endpoints for the dashboard and the alert-only watchdog.
      4. After the next `:x0`, `GET /api/executor/runs?limit=3` shows the run from Railway.
   2. Fund the account (README §4.8 Capital): USDC in the account, no other transfers needed in
      unified mode.
   3. Create the executor's API wallet key (a fresh key; its address is `GET /status` → `apiWallet`
      once `HL_API_WALLET_KEY` is set).
   4. With the **master key**, on your own machine (never on a server):
      ```sh
      cd packages/executor
      HL_ACCOUNT=0x… HL_API_WALLET_ADDRESS=0x… bun run scripts/setup-account.ts            # status
      HL_ACCOUNT=0x… HL_API_WALLET_ADDRESS=0x… HL_MASTER_KEY=0x… bun run scripts/setup-account.ts --apply
      ```
      This switches the account to **unified** mode (one USDC balance margins core and `xyz`
      perps) and approves the API wallet (trade, no withdraw). It never moves funds.
   5. Set `HL_API_WALLET_KEY` and `DRY_RUN=false` on the executor and redeploy. Watch the next
      run's `results` in `/runs`.
   6. **Crash recovery is automatic:** an unresolved entry in `GET /admin/order-batches` is an
      exchange action without a recorded outcome (a lost response or a crash). The next run
      reconciles it from Hyperliquid by client order ID, once its signed expiry (run time + 5 min)
      has passed or every order is already final. It closes the batch with
      `resolved_by = 'auto-reconciler'` and the order statuses as evidence, and trades on. A
      Telegram alert says what was reconciled. Nothing pauses; pausing and flattening are human
      actions. `POST /admin/reconcile-batch` is still there to close a batch by hand.

## Freeze (bootstrap or operator-managed set)

The pipeline's roster normally creates and activates a validated `FrozenConfiguration` in
Supabase. The file below is the bootstrap fallback or an explicit operator-managed configuration;
changing it does not override an existing active database row. The core's `proposeFreeze`
(`packages/shared/src/frozen.ts`) can produce such a configuration for the operator tool.
Its `account` must be our HL account, and its `chainId` is part of its hash.

```sh
cd packages/backend
bun run scripts/freeze.ts path/to/frozen-configuration.json --account 0xOUR_ACCOUNT           # check
bun run scripts/freeze.ts path/to/frozen-configuration.json --account 0xOUR_ACCOUNT --write   # save
```

`--write` saves it as `packages/backend/frozen/live.json`; the script prints the variables to set
on Vercel (`CONFIGURATION_PATH=frozen/live.json`, `FROZEN_CONFIGURATION_HASH`, `HL_ACCOUNT`,
`MAX_GROSS_LEVERAGE`). Review the file and environment changes before deploying. Both services
must agree on the effective configuration (active database row, otherwise file/hash). A mismatch
fails closed. A file redeploy alone is not a rollback of a roster's active configuration.

## Stop

```sh
curl -X POST -H "Authorization: Bearer $ADMIN_TOKEN" -H "x-operator: $NAME" $EXECUTOR/admin/pause    # stop trading, keep positions
curl -X POST -H "Authorization: Bearer $ADMIN_TOKEN" -H "x-operator: $NAME" $EXECUTOR/admin/resume
curl -X POST -H "Authorization: Bearer $ADMIN_TOKEN" -H "x-operator: $NAME" $EXECUTOR/admin/flatten  # pause + close everything
```

Flatten ignores the targets and stays paused afterwards. It queues behind a run in progress; if a
run is stuck (alert "still running after …"), use the long-running executor's recovery procedure,
then flatten through that executor. A Vercel dry-run instance cannot flatten live positions. While paused, runs are still recorded
(`skipped_paused`) but send nothing.

## Data for the dashboard (README §4.11)

`/exposures` keeps `runAt` and `exposures` unchanged. Its optional `sources` contains every snapshot
wallet, its frozen weight as a fraction, and contributions as fractions of equity. Each raw
source contribution is multiplied by the asset's final target / raw net, reconciling the breakdown
after position limiting and gross capping. Zero/dropped targets are omitted; flat wallets have
empty contributions. A failed breakdown is logged and omits `sources` without failing the old
response. The response is cached per run. These contributions are attribution only; they do not
change policy or execution.

| Source | What | Access |
|---|---|---|
| `GET {backend}/paper[?since=unix]` | paper books: equity, return, fees, funding, trades, open positions, equity curve (≤ 1,500 points, rebuilt once per run) | public, CORS `*` |
| `GET {backend}/exposures` | the target exposures of the last run the paper books stepped: `runAt`, `exposures: [{ asset, fraction }]`, plus optional `sources: [{ address, weight, contributions: [{ asset, fraction }] }]` | public, CORS `*` |
| `GET {backend}/snapshots/:runAt`, `/targets/:runAt` | a run's positions snapshot (exact bytes) and its target exposures | public, CORS `*` |
| `GET {backend}/artifacts/backtest`, `/artifacts/funnel` | what other jobs published to `dashboard_artifacts` (below); 404 until then | public, CORS `*` |
| `GET {executor}/status` | dry run on/off, account, API wallet, pinned configuration hash, last run time, kill-switch state | public, CORS `*` |
| `GET {executor}/runs?summary=1&limit=N` (≤ 500) | runs without plan, results and evidence: time, status, equity, order count | public, CORS `*` |
| `GET {executor}/equity` | the live account's equity at every executed run since the start (≤ 1,500 points, cached 1 min) | public, CORS `*` |
| `GET {executor}/runs?limit=N` (≤ 200) | per run: `runId`, `kind`, `status`, `dryRun`, equity, `plan` (orders, skipped legs with reasons, margin scale), `results` (per-order fill/error), `evidence` (snapshot hash, configuration hash, targets) | public, CORS `*` |
| Supabase `executor_runs` | same rows as `/runs` | anon `select` |
| Supabase `run_snapshots` | each run's snapshot JSON (`body`, exact bytes) and its keccak hash | anon `select` |
| Supabase `run_targets` | target history: one row per perp per run (target exposure and USD, held, gap, the order or skip reason, the fill) | anon `select` |
| Supabase `executor_controls` | kill-switch state | anon `select` |

### Publishing optional historical backtest and funnel artifacts

Historical jobs can publish documents to `dashboard_artifacts` (service role); the dashboard
reads them separately from the current `/pipeline` finalists and roster. Publishing artifacts
is not a required production selection step. Shapes: `packages/shared/dashboard.ts`.
Publish with the checker, which refuses anything that would render wrong (seconds instead of
milliseconds, a series not indexed to 1.0, no BTC benchmark, a funnel stage growing):

```sh
bun scripts/publish-artifact.ts backtest backtest.json                       # check only
DATABASE_URL=<service role> bun scripts/publish-artifact.ts backtest backtest.json --write
```

The SQL it runs, for jobs that write directly:

```sql
insert into dashboard_artifacts (name, body) values ('backtest', '{
  "generatedAt": 1791277800000, "window": "1 month",
  "series": [
    {"id": "algo",    "label": "Algo only",      "points": [[1788685800000, 1.0], [1788707400000, 1.004]]},
    {"id": "model-a", "label": "Model A",        "points": [...]},
    {"id": "model-b", "label": "Model B",        "points": [...]},
    {"id": "btc",     "label": "BTC buy & hold", "points": [...]}
  ]}'::jsonb)
on conflict (name) do update set body = excluded.body, updated_at = now();
```

- `backtest`: points are `[unix ms, value]` with **1.0 = start of the window**; the series with
  `id: "btc"` is drawn as the dashed benchmark.
- `funnel`: `steps` in order (`{stage, label, count}`, e.g. 47k addresses → … → finalists → frozen
  set) and optionally `finalists` (`{address, kind, score, picked, rationale?}`); `picked` marks the
  frozen set. The finalists panel renders from this field.
- Locally (no `DATABASE_URL`), drop `backtest.json` / `funnel.json` in the backend's
  `ARTIFACTS_DIR` instead.

Checking a run independently: fetch `GET {backend}/snapshots/<runAt>`, take `keccak256` of the exact
response bytes and compare it with the run's `evidence.snapshotHash`; `targetsFromSnapshot`
(`packages/shared/copy.ts`) on that snapshot reproduces `evidence.exposures`.

## When something fails

| Symptom | Where to look | Usual cause |
|---|---|---|
| No runs in `/runs`, Telegram "no finished run for N min" | Long-running executor health/logs, then backend snapshot cron | The executor process/timer stopped, a snapshot failed, or runs are failing; Vercel has no scheduled `/cron/run` |
| Run `failed` with `backend targets for …` | Backend logs (`snapshot failed`, `targets served`) | Backend down, HL slow or unreachable, or the run asked too late (> 120 s after `:x0`) |
| Run `failed` with `configuration mismatch` / `account mismatch` | Active `configurations` row, bootstrap hash and `HL_ACCOUNT` | Effective configuration/account differs between services |
| Run `failed` with invalid configuration / `ineligible asset` | Active configuration and the run's snapshot | Configuration or snapshot validation failed; flat sources no longer cause active-weight renormalization |
| Run `failed`, other `error` | `error` on the run | HL unreachable, or the gross-leverage bound |
| Orders with `status: "error"` | `results` on the run | HL rejection (min size, margin); the next run retries |
| `/cron/run` answers `duplicate` | — | Normal: another trigger (retry, a second instance) already ran that slot |
| Dashboard pills say "Executor offline" / panels empty | Browser console (CORS, mixed content) | `NEXT_PUBLIC_*` URLs wrong or not `https`; redeploy after fixing them |
| Paper curves stop | Backend log `paper books not stepped` (with the reason) | The run's targets can't be built (the books hold, like the executor), HL marks unavailable, or no snapshot was built |

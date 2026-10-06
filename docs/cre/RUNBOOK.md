# CRE mirror runbook

How to run, deploy, freeze and stop the live copy-trading path: backend snapshot service →
CRE `mirror` workflow → executor. Design: README §4.7, §4.8, §4.13, §4.14.

## Pieces

| Piece | Code | Runs on | Talks to |
|---|---|---|---|
| Snapshot service | `packages/backend` (`src/server.ts`) | Railway | HL Info API, Supabase |
| `mirror` workflow | `packages/cre-workflows/mirror` | Chainlink DON (private registry) | snapshot service, HL Info API, executor |
| Executor | `packages/executor` (`src/server.ts`) | Railway | HL Info + Exchange API, Ethereum RPC (DON signers), Supabase, Telegram |
| Paper books | `packages/backend/src/paper` (inside the snapshot service) | Railway | HL Info API (marks), Supabase |
| Dashboard | `packages/dashboard` (Next.js) | Vercel | snapshot service, executor (browser fetches, read-only) |
| Tables | `supabase/migrations/20261006120000_cre_mirror.sql` | Supabase | — |

## Run it locally

Needs Bun ≥ 1.2.21, the `cre` CLI (logged in) and network access. Nothing here sends an order.

```sh
./scripts/e2e-mirror.sh          # backend → cre simulate mirror → executor (dry run), checks the result
DATABASE_URL=postgres://… ./scripts/e2e-mirror.sh   # same, with both services on Postgres
./scripts/soak-mirror.sh         # soak: simulate every 90 s for 40 rounds, then a pass/fail summary
```

The soak keeps the snapshot service and executor running and simulates the mirror repeatedly
against live HL data, to catch flakiness, leaks and snapshot-age drift a single run can't
(`ROUNDS`, `INTERVAL`, `DATABASE_URL` configurable). It stops early if the code changes under it.
Reference results (2026-10-06): every round on a consistent setup passed; spot-check deviation
0–30 bps for snapshots under 2 minutes old, ~50 bps at 8 minutes (limit 500).

Unit tests per package: `bun test` in `packages/backend`, `packages/executor`,
`packages/cre-workflows/mirror`, `packages/cre-workflows/review`. Postgres integration tests run when
`TEST_DATABASE_URL` is set (see `packages/executor/test/pg-store.test.ts`).

## Environment

### Snapshot service (`packages/backend`)

| Variable | Required | Meaning |
|---|---|---|
| `CONFIGURATION_PATH` | yes | Frozen configuration JSON (the review core's freeze output) |
| `FROZEN_CONFIGURATION_HASH` | yes | Its `configurationHash`; the service refuses any other |
| `DATABASE_URL` | prod | Supabase Postgres (service role). Without it snapshots and the eligibility list live in memory |
| `SNAPSHOT_MAX_LEAD_SECONDS` | no | How close to a run a snapshot may be built (default 120). `600` only for local simulation |
| `PAPER_BALANCED_MULTIPLIER` | no | Balanced book = Aggressive weights × this (default 0.5) |
| `PAPER_SLIPPAGE_BPS` | no | Paper fills at mark ± this (default 5) |
| `ARTIFACTS_DIR` | no | Without `DATABASE_URL`: folder of `backtest.json` / `funnel.json` for the dashboard (default `artifacts`) |
| `PORT` | no | Railway sets it |

### Executor (`packages/executor`)

| Variable | Required | Default | Meaning |
|---|---|---|---|
| `HL_ACCOUNT` | yes | — | Our HL master account (must equal the configuration's `account`) |
| `FROZEN_CONFIGURATION_HASH` | yes | — | Same as the mirror's `frozenConfigurationHash` |
| `WORKFLOW_OWNER` | yes | — | `0xc5feb3cf878c9ba42a776e9edf62a4558ab08b85` (org address, private registry) |
| `NODE_ENV` | prod | — | `production` refuses `VERIFY_REPORTS=false` and requires `ADMIN_TOKEN` |
| `ADMIN_TOKEN` | prod | — | Bearer token for `/admin/*` |
| `DRY_RUN` | no | `true` | Only the literal `false` sends orders |
| `HL_API_WALLET_KEY` | live | — | API wallet (agent) key: trades, can't withdraw. Required when `DRY_RUN=false` |
| `DATABASE_URL` | prod | — | Supabase Postgres. Without it dedupe, runs and the kill switch are in memory |
| `ETH_MAINNET_RPC_URL` | no | publicnode | Reads DON signers from the Capability Registry |
| `VERIFY_REPORTS` | no | `true` | `false` only for `cre workflow simulate` reports |
| `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID` | no | — | Alerts; without them alerts are logged only |
| `SLIPPAGE_BPS` | no | `50` | IOC limit = mark ± this |
| `MIN_ORDER_USD` / `DRIFT_FRACTION` / `MARGIN_CAP` | no | `10` / `0.1` / `0.95` | README §4.4, §4.8 |
| `MAX_GROSS_LEVERAGE` | no | `10` | Sanity bound: reject reports whose gross exposure exceeds this |
| `MAX_REPORT_LEAD_SECONDS` | no | `60` | How far `asOf` may be ahead of our clock (`600` for simulation) |
| `MAX_REPORT_TTL_SECONDS` | no | `300` | Longest report lifetime accepted (`expiresAt − asOf`) |
| `RUN_TIMEOUT_SECONDS` | no | `60` | A run still going after this is alerted on and stops before its next order batch; the next run waits for it to finish |
| `WORKFLOW_NAME` | live | — | 10-byte hex from the first real report (`verify-run` prints it); pins the production workflow. Required for `DRY_RUN=false` in production |
| `DON_ID` | live | — | Pins the DON (`verify-run` prints it). Required for `DRY_RUN=false` in production |
| `MISSED_RUN_ALERT_MINUTES` | no | `25` | Alert after this long without a finished run |

### Dashboard (`packages/dashboard`, Vercel)

| Variable | Meaning |
|---|---|
| `NEXT_PUBLIC_BACKEND_URL` | Snapshot service URL (no trailing slash) |
| `NEXT_PUBLIC_EXECUTOR_URL` | Executor URL |

Both are baked in at build time: redeploy the dashboard after changing them. Locally they default to
`localhost:8788` / `localhost:8787` (`bun run dev`, then `?theme=light|dark` pins a mode).

### `mirror` workflow (`config.production.json`)

Secret `mirrorSamplingKey` (`secrets.yaml` → env `MIRROR_SAMPLING_KEY`): 32 bytes as `0x` + 64 hex,
e.g. `openssl rand -hex 32`. It seeds the spot-check sample, so **keep it away from the snapshot
service** (if the backend knew it, it could predict which sources get checked). Simulation reads it
from `packages/cre-workflows/.env` or the environment (`e2e-mirror.sh` generates one); deployed, it
lives in the Vault DON: `CRE_CLI_SECRETS_ORG_OWNED=true cre secrets create secrets.yaml --target
production-settings --secrets-auth=browser` from `packages/cre-workflows`.

Config: `backendUrl`, `executorUrl`, `frozenConfigurationHash`, `spotCheckCount` (≤ 4: HTTP budget),
`maxDeviationBps` (500), `maxSnapshotAgeSeconds` (120), `reportTtlSeconds` (300). No secrets.
The production file holds placeholders until the services are deployed and the set is frozen.

## Deploy

Before and after each step, `bun scripts/predeploy-check.ts --backend https://… --executor https://…
[--dashboard https://…]` (with `DATABASE_URL=…` to include Supabase) checks that the mirror config,
`frozen/live.json`, both services and the tables agree. Read-only; exit 1 on any failure.
To deploy everything before CRE deploy access and the freeze, follow
[DEPLOY_REHEARSAL.md](DEPLOY_REHEARSAL.md) first.

1. **Supabase:** project `PerpParrot` (ref `clheeepphmomkymawsfq`, linked to this repo with working
   directory `.`, automatic deploys off; see `docs/supabase` on its branch). Run
   both files in `supabase/migrations/` in order (SQL editor, or `supabase link
   --project-ref clheeepphmomkymawsfq && supabase db push`). Use the service-role connection
   string as `DATABASE_URL` for both services.
2. **Railway:** two services from this repo, **root directory = repository root** (both import
   `packages/shared`). Config file: `packages/backend/railway.json` and
   `packages/executor/railway.json` (Dockerfile build, `/health` check, one replica each).
   Keep the executor at **one replica**: it owns the HL nonce sequence and the run queue.
3. **Executor:** set the variables above with `DRY_RUN` unset (dry run). Check `GET /status`.
4. **`mirror`:** create the `mirrorSamplingKey` secret (above), put the two Railway URLs and the configuration hash in
   `packages/cre-workflows/mirror/config.production.json`, merge, then run the **CRE deploy**
   GitHub Action (`mirror`, `production-settings`). Needs deploy access and `CRE_API_KEY`.
5. **Dashboard (Vercel):** new project from this repo, **Root Directory `packages/dashboard`**
   (keep "Include files outside the root directory" on: it imports types from `packages/shared`).
   Framework, install and build come from `packages/dashboard/vercel.json`. Set the two
   `NEXT_PUBLIC_*` variables to the Railway URLs, deploy, and open it: the header should read
   "Dry run · Copying" and the heartbeat gains a cell every 10 minutes.
6. **Watch a dry-run cycle:** `GET {executor}/runs?limit=3` should show a run every 10 minutes
   with `status: "executed"`, `dryRun: true` and a plan you agree with. Then run
   `bun run scripts/verify-run.ts --executor … --backend …` in `packages/executor` and set
   `WORKFLOW_NAME` and `DON_ID` on the executor from what it prints.
7. **Go live** (not part of the dry-run rehearsal):
   1. Fund the account (README §4.8 Capital): USDC in the account, no other transfers needed in
      unified mode.
   2. Create the executor's API wallet key (a fresh key; its address is `GET /status` → `apiWallet`
      once `HL_API_WALLET_KEY` is set).
   3. With the **master key**, on your own machine (never on Railway):
      ```sh
      cd packages/executor
      HL_ACCOUNT=0x… HL_API_WALLET_ADDRESS=0x… bun run scripts/setup-account.ts            # status
      HL_ACCOUNT=0x… HL_API_WALLET_ADDRESS=0x… HL_MASTER_KEY=0x… bun run scripts/setup-account.ts --apply
      ```
      This switches the account to **unified** mode (one USDC balance margins core and `xyz`
      perps) and approves the API wallet (trade, no withdraw). It never moves funds.
   4. Set `HL_API_WALLET_KEY` and `DRY_RUN=false` on the executor and redeploy. Watch the next
      run's `results` in `/runs`.

## Freeze (go-live set)

The review core produces a `FrozenConfiguration` (branch `ai-agent-workflow`, `proposeFreeze`).
Its `account` must be our HL account, and its `chainId` is part of its hash.

```sh
cd packages/backend
bun run scripts/freeze.ts path/to/frozen-configuration.json --account 0xOUR_ACCOUNT           # check
bun run scripts/freeze.ts path/to/frozen-configuration.json --account 0xOUR_ACCOUNT --write   # save
```

`--write` saves it as `packages/backend/frozen/live.json` and pins its hash in
`mirror/config.production.json`; the script prints the Railway variables to set
(`CONFIGURATION_PATH=frozen/live.json` and `FROZEN_CONFIGURATION_HASH` on the snapshot service,
`FROZEN_CONFIGURATION_HASH` and `HL_ACCOUNT` on the executor). Commit, redeploy **both services
first**, then `mirror` (CRE deploy Action): the Action checks that the services already pin the
new hash and stops otherwise. Until all three agree, runs fail closed: the backend won't serve,
the mirror rejects the snapshot, or the executor rejects the report.

## Stop

```sh
curl -X POST -H "Authorization: Bearer $ADMIN_TOKEN" -H "x-operator: $NAME" $EXECUTOR/admin/pause    # stop trading, keep positions
curl -X POST -H "Authorization: Bearer $ADMIN_TOKEN" -H "x-operator: $NAME" $EXECUTOR/admin/resume
curl -X POST -H "Authorization: Bearer $ADMIN_TOKEN" -H "x-operator: $NAME" $EXECUTOR/admin/flatten  # pause + close everything
```

Flatten bypasses CRE and stays paused afterwards. It queues behind a run in progress; if a run is
stuck (alert "still running after …"), restart the executor on Railway, then flatten. To stop CRE itself, pause the workflow in the
CRE UI or with `cre workflow pause`.

## Data for the dashboard (README §4.11)

| Source | What | Access |
|---|---|---|
| `GET {backend}/paper[?since=unix]` | paper books: equity, return, fees, funding, trades, open positions, equity curve (≤ 1,500 points, rebuilt once per run) | public, CORS `*` |
| `GET {backend}/exposures` | the target exposures of the last run the paper books stepped (fraction of equity per asset) | public, CORS `*` |
| `GET {backend}/artifacts/backtest`, `/artifacts/funnel` | what other jobs published to `dashboard_artifacts` (below); 404 until then | public, CORS `*` |
| `GET {executor}/status` | dry run on/off, account, API wallet, pinned configuration hash, last report time, kill-switch state | public, CORS `*` |
| `GET {executor}/runs?summary=1&limit=N` (≤ 500) | runs without plan, results and report: time, status, equity, order count | public, CORS `*` |
| `GET {executor}/equity` | the live account's equity at every executed run since the start (≤ 1,500 points, cached 1 min) | public, CORS `*` |
| `GET {executor}/runs?limit=N` (≤ 200) | per run: `runId`, `status`, `dryRun`, equity, `plan` (orders, skipped legs with reasons, margin scale), `results` (per-order fill/error), `envelope` (raw DON-signed report) | public, CORS `*` |
| Supabase `executor_runs` | same rows as `/runs` | anon `select` |
| Supabase `cre_snapshots` | each run's snapshot JSON (`body`, exact bytes) and its keccak hash | anon `select` |
| Supabase `executor_controls` | kill-switch state | anon `select` |

### Publishing the backtest, funnel and finalists

The backtest and the score/ingest jobs publish one JSON document each to `dashboard_artifacts`
(service role); the dashboard picks it up within a minute. Shapes: `packages/shared/dashboard.ts`.
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
- Locally (no `DATABASE_URL`), drop `backtest.json` / `funnel.json` in the snapshot service's
  `ARTIFACTS_DIR` instead.

Re-verifying a run's report, independently of the executor:

```sh
cd packages/executor
bun run scripts/verify-run.ts --executor https://… --backend https://… [--run mirror-…]
```

It checks ≥ f+1 DON signatures against the Capability Registry and the pinned workflow owner, that
the run ID is `keccak256(report)`, and that the stored snapshot hashes to the report's
`snapshotHash` (`--simulation` for runs from `cre workflow simulate`). By hand: `envelope.report` is the raw report (109-byte header + ABI body,
`packages/shared/report.ts`). `keccak256(report)` is the run `id`; the body's `snapshotHash` is
`keccak256` of the stored snapshot `body`; signatures verify against the Capability Registry as in
`packages/executor/src/verify.ts`.

## When something fails

| Symptom | Where to look | Usual cause |
|---|---|---|
| No runs in `/runs`, Telegram "no report for N min" | CRE UI → workflow executions | Mirror run failing (see its error) or not deployed |
| Mirror error `snapshot fetch failed` / `snapshot taken …s before the run` | Snapshot service logs | Service down, or HL slow at `:x9` |
| Mirror error `not the pinned frozen authority` / `commitment mismatch` | Hashes in all three places | Freeze steps out of sync |
| Mirror error `spot-check failed` | Mirror log line with the deviation | A bad or stale snapshot (normal deviation is 0–30 bps for a 60–90 s old snapshot; the soak test saw ~50 bps at 8 min). Holds this run only |
| Mirror error `executor rejected the report: HTTP 401` | Executor logs | Signature/owner check: `WORKFLOW_OWNER`, Ethereum RPC |
| `HTTP 422` | Executor logs (`error` field) | Configuration hash, account or expiry mismatch |
| Run `failed` in `/runs` | `error` on the run | HL unreachable, or the gross-leverage bound |
| Orders with `status: "error"` | `results` on the run | HL rejection (min size, margin); the next run retries |
| Dashboard pills say "Executor offline" / panels empty | Browser console (CORS, mixed content) | `NEXT_PUBLIC_*` URLs wrong or not `https`; redeploy after fixing them |
| Paper curves stop | Snapshot service log `paper books not stepped` (with the reason) | The run fails the mirror's checks (the books hold, like the executor), HL marks unavailable, or no snapshot was requested |

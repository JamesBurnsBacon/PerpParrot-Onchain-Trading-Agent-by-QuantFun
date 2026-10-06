# CRE mirror runbook

How to run, deploy, freeze and stop the live copy-trading path: backend snapshot service →
CRE `mirror` workflow → executor. Design: README §4.7, §4.8, §4.13, §4.14.

## Pieces

| Piece | Code | Runs on | Talks to |
|---|---|---|---|
| Snapshot service | `packages/backend` (`src/server.ts`) | Railway | HL Info API, Supabase |
| `mirror` workflow | `packages/cre-workflows/mirror` | Chainlink DON (private registry) | snapshot service, HL Info API, executor |
| Executor | `packages/executor` (`src/server.ts`) | Railway | HL Info + Exchange API, Ethereum RPC (DON signers), Supabase, Telegram |
| Tables | `supabase/migrations/20261006120000_cre_mirror.sql` | Supabase | — |

## Run it locally

Needs Bun ≥ 1.2.21, the `cre` CLI (logged in) and network access. Nothing here sends an order.

```sh
./scripts/e2e-mirror.sh          # backend → cre simulate mirror → executor (dry run), checks the result
DATABASE_URL=postgres://… ./scripts/e2e-mirror.sh   # same, with both services on Postgres
```

Unit tests per package: `bun test` in `packages/backend`, `packages/executor`,
`packages/cre-workflows/mirror`, `packages/cre-workflows/review`. Postgres integration tests run when
`TEST_DATABASE_URL` is set (see `packages/executor/test/pg-store.test.ts`).

## Environment

### Snapshot service (`packages/backend`)

| Variable | Required | Meaning |
|---|---|---|
| `CONFIGURATION_PATH` | yes | Frozen configuration JSON (the review core's freeze output) |
| `FROZEN_CONFIGURATION_HASH` | yes | Its `configurationHash`; the service refuses any other |
| `DATABASE_URL` | prod | Supabase Postgres (service role). Without it snapshots live in memory |
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
| `MISSED_RUN_ALERT_MINUTES` | no | `25` | Alert after this long without a report |

### `mirror` workflow (`config.production.json`)

`backendUrl`, `executorUrl`, `frozenConfigurationHash`, `spotCheckCount` (≤ 4: HTTP budget),
`maxDeviationBps` (500), `maxSnapshotAgeSeconds` (120), `reportTtlSeconds` (300). No secrets.
The production file holds placeholders until the services are deployed and the set is frozen.

## Deploy

1. **Supabase:** run `supabase/migrations/20261006120000_cre_mirror.sql` (SQL editor or
   `supabase db push`). Use the service-role connection string as `DATABASE_URL`.
2. **Railway:** two services from this repo, **root directory = repository root** (both import
   `packages/shared`). Config file: `packages/backend/railway.json` and
   `packages/executor/railway.json` (Dockerfile build, `/health` check, one replica each).
   Keep the executor at **one replica**: it owns the HL nonce sequence and the run queue.
3. **Executor:** set the variables above with `DRY_RUN` unset (dry run). Check `GET /status`.
4. **`mirror`:** put the two Railway URLs and the configuration hash in
   `packages/cre-workflows/mirror/config.production.json`, merge, then run the **CRE deploy**
   GitHub Action (`mirror`, `production-settings`). Needs deploy access and `CRE_API_KEY`.
5. **Watch a dry-run cycle:** `GET {executor}/runs?limit=3` should show a run every 10 minutes
   with `status: "executed"`, `dryRun: true` and a plan you agree with.
6. **Go live:**
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
Its `account` must be our HL account and `chainId` is part of its hash.

1. Save the JSON where the snapshot service reads it (`CONFIGURATION_PATH`); set
   `FROZEN_CONFIGURATION_HASH` on the snapshot service **and** the executor.
2. Set `frozenConfigurationHash` in `mirror/config.production.json` and redeploy `mirror`
   (the hash becomes part of the workflow ID).
3. Until all three agree, runs fail closed: the backend won't serve, the mirror rejects the
   snapshot, or the executor rejects the report.

## Stop

```sh
curl -X POST -H "Authorization: Bearer $ADMIN_TOKEN" -H "x-operator: $NAME" $EXECUTOR/admin/pause    # stop trading, keep positions
curl -X POST -H "Authorization: Bearer $ADMIN_TOKEN" -H "x-operator: $NAME" $EXECUTOR/admin/resume
curl -X POST -H "Authorization: Bearer $ADMIN_TOKEN" -H "x-operator: $NAME" $EXECUTOR/admin/flatten  # pause + close everything
```

Flatten bypasses CRE and stays paused afterwards. To stop CRE itself, pause the workflow in the
CRE UI or with `cre workflow pause`.

## Data for the dashboard (README §4.11)

| Source | What | Access |
|---|---|---|
| `GET {executor}/status` | dry run on/off, account, API wallet, pinned configuration hash, last report time, kill-switch state | public, CORS `*` |
| `GET {executor}/runs?limit=N` (≤ 200) | per run: `runId`, `status`, `dryRun`, equity, `plan` (orders, skipped legs with reasons, margin scale), `results` (per-order fill/error), `envelope` (raw DON-signed report) | public, CORS `*` |
| Supabase `executor_runs` | same rows as `/runs` | anon `select` |
| Supabase `cre_snapshots` | each run's snapshot JSON (`body`, exact bytes) and its keccak hash | anon `select` |
| Supabase `executor_controls` | kill-switch state | anon `select` |

Re-verifying a run's report: `envelope.report` is the raw report (109-byte header + ABI body,
`packages/shared/report.ts`). `keccak256(report)` is the run `id`; the body's `snapshotHash` is
`keccak256` of the stored snapshot `body`; signatures verify against the Capability Registry as in
`packages/executor/src/verify.ts`.

## When something fails

| Symptom | Where to look | Usual cause |
|---|---|---|
| No runs in `/runs`, Telegram "no report for N min" | CRE UI → workflow executions | Mirror run failing (see its error) or not deployed |
| Mirror error `snapshot fetch failed` / `snapshot taken …s before the run` | Snapshot service logs | Service down, or HL slow at `:x9` |
| Mirror error `not the pinned frozen authority` / `commitment mismatch` | Hashes in all three places | Freeze steps out of sync |
| Mirror error `spot-check failed` | Mirror log line with the deviation | A source traded between `:x9` and `:x0`, or a bad snapshot. Holds this run only |
| Mirror error `executor rejected the report: HTTP 401` | Executor logs | Signature/owner check: `WORKFLOW_OWNER`, Ethereum RPC |
| `HTTP 422` | Executor logs (`error` field) | Configuration hash, account or expiry mismatch |
| Run `failed` in `/runs` | `error` on the run | HL unreachable, or the gross-leverage bound |
| Orders with `status: "error"` | `results` on the run | HL rejection (min size, margin); the next run retries |

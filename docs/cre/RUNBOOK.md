# CRE mirror runbook

How to run, deploy, freeze and stop the live copy-trading path: backend snapshot service →
CRE `mirror` workflow → executor. Design: README §4.7, §4.8, §4.13, §4.14.

## Pieces

| Piece | Code | Runs on | Talks to |
|---|---|---|---|
| Snapshot service | `packages/backend` (`src/server.ts`) | Railway | HL Info API, Supabase |
| `mirror` workflow | `packages/cre-workflows/mirror` | Chainlink DON (private registry) | snapshot service, HL Info API, executor |
| Executor | `packages/executor` (`src/server.ts`) | Railway | HL Info + Exchange API, Ethereum RPC (DON signers), Supabase, Telegram |
| Tables | `supabase/migrations/20261006120000_cre_mirror.sql`, `20261006180000_executor_order_journal.sql` | Supabase | — |

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
| `PORT` | no | Railway sets it |

### Executor (`packages/executor`)

| Variable | Required | Default | Meaning |
|---|---|---|---|
| `HL_ACCOUNT` | yes | — | Our HL master account (must equal the configuration's `account`) |
| `FROZEN_CONFIGURATION_HASH` | yes | — | Same as the mirror's `frozenConfigurationHash` |
| `WORKFLOW_OWNER` | yes | — | `0xc5feb3cf878c9ba42a776e9edf62a4558ab08b85` (org address, private registry) |
| `NODE_ENV` | prod | — | `production` refuses `VERIFY_REPORTS=false` and requires `ADMIN_TOKEN` plus durable `DATABASE_URL` |
| `ADMIN_TOKEN` | prod | — | Bearer token for `/admin/*` |
| `DRY_RUN` | no | `true` | Only the literal `false` sends orders |
| `HL_API_WALLET_KEY` | live | — | API wallet (agent) key: trades, can't withdraw. Required when `DRY_RUN=false` |
| `DATABASE_URL` | prod | — | Required in production. Supabase Postgres for report dedupe, runs and persistent kill switch |
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

1. **Supabase:** project `PerpParrot` (ref `clheeepphmomkymawsfq`, linked to this repo with working
   directory `.`, automatic deploys off; see `docs/supabase` on its branch). Run
   both `supabase/migrations/20261006120000_cre_mirror.sql` and
   `supabase/migrations/20261006180000_executor_order_journal.sql` (SQL editor, or
   `supabase link --project-ref clheeepphmomkymawsfq && supabase db push`). Use the service-role connection
   string as `DATABASE_URL` for both services.
2. **Railway:** two services from this repo, **root directory = repository root** (both import
   `packages/shared`). Config file: `packages/backend/railway.json` and
   `packages/executor/railway.json` (Dockerfile build, `/health` check, one replica each).
   Keep the executor at **one replica**: it owns the HL nonce sequence and the run queue.
3. **Executor:** set the variables above with `DRY_RUN` unset (dry run). Check `GET /status`.
4. **`mirror`:** create the `mirrorSamplingKey` secret (above), put the two Railway URLs and the configuration hash in
   `packages/cre-workflows/mirror/config.production.json`, merge, then run the **CRE deploy**
   GitHub Action (`mirror`, `production-settings`). Needs deploy access and `CRE_API_KEY`.
5. **Watch a dry-run cycle:** `GET {executor}/runs?limit=3` should show a run every 10 minutes
   with `status: "executed"`, `dryRun: true` and a plan you agree with. Then run
   `bun run scripts/verify-run.ts --executor … --backend …` in `packages/executor` and set
   `WORKFLOW_NAME` and `DON_ID` on the executor from what it prints.
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
Its `account` must be our HL account, and its `chainId` is part of its hash.

```sh
cd packages/backend
bun run scripts/freeze.ts path/to/frozen-configuration.json --account 0xOUR_ACCOUNT           # check
bun run scripts/freeze.ts path/to/frozen-configuration.json --account 0xOUR_ACCOUNT --write   # save
```

`--write` saves it as `packages/backend/frozen/live.json` and pins its hash in
`mirror/config.production.json`; the script prints the Railway variables to set
(`CONFIGURATION_PATH=frozen/live.json` and `FROZEN_CONFIGURATION_HASH` on the snapshot service,
`FROZEN_CONFIGURATION_HASH` and `HL_ACCOUNT` on the executor). Commit, then redeploy `mirror`
(CRE deploy Action) and both services. Until all three agree, runs fail closed: the backend
won't serve, the mirror rejects the snapshot, or the executor rejects the report.

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
| `GET {executor}/status` | dry run on/off, account, API wallet, pinned configuration hash, last report time, kill-switch state | public, CORS `*` |
| `GET {executor}/runs?limit=N` (≤ 200) | per run: `runId`, `status`, `dryRun`, equity, `plan` (orders, skipped legs with reasons, margin scale), `results` (per-order fill/error), `envelope` (raw DON-signed report) | public, CORS `*` |
| Supabase `executor_runs` | same rows as `/runs` | anon `select` |
| Supabase `cre_snapshots` | each run's snapshot JSON (`body`, exact bytes) and its keccak hash | anon `select` |
| Supabase `executor_controls` | kill-switch state | anon `select` |

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

### Unknown exchange outcomes and delayed actions

The executor passes each report's expiry (Unix milliseconds) into the SDK's
signed `expiresAfter` field for leverage updates and IOC order actions. It also
rechecks durable pause controls, cancellation and expiry before each exchange
action and between order batches. An already dispatched action cannot be recalled
by a later local pause.

A lost response is recorded as `unknown`, not as a confirmed exchange rejection.
No later batch is sent, the run is marked `failed`, and the executor writes a
persistent pause. Earlier returned fills remain in the run record. Explicit
per-order rejections also mark the run failed, while preserving successful fills.

Before clearing an unknown-outcome pause:

1. Read the failed run's planned orders and derive each client order ID using
   `cloidFor(run.id, asset)` in `packages/executor/src/runner.ts`.
2. Query Hyperliquid order status by client order ID and compare the current
   account positions and fills. An absent order response alone does not establish
   that the action was never accepted.
3. Record reconciliation evidence, then resume using the authenticated admin
   controls. Do not replay the old signed report or assume repeated client order
   IDs provide exchange idempotency; the next fresh report plans against live equity.

The executor now writes a durable pre-dispatch journal and pauses on unresolved
actions at startup and before later reports. Reconciliation is manual: the endpoint
records an operator attestation but does not query Hyperliquid or verify that the
originating process has stopped. Before clearing a `dispatching` row, stop/fence every
executor instance and confirm no exchange request remains in flight. Then inspect
Hyperliquid state, record evidence, and keep the executor paused until every unresolved
batch has been reviewed and an operator explicitly resumes it. This reduces crash
risk but does not make Hyperliquid and Postgres atomic. CRE/model credentials, deployed
consensus, persistent-store recovery drills and deployment-level soak checks remain
funded-launch gates. Local mocked transport tests do not prove real exchange execution.

References: [Hyperliquid exchange endpoint](https://hyperliquid.gitbook.io/Hyperliquid-docs/for-developers/api/exchange-endpoint)
and [order-status queries](https://hyperliquid.gitbook.io/Hyperliquid-docs/for-developers/api/info-endpoint).

### Preparing synchronized freeze artifacts

`scripts/freeze.ts` now validates the frozen authority and mirror settings before
writing either file. The prepared pair binds the same configuration hash and
prints executor `HL_ACCOUNT`, `MAX_REPORT_TTL_SECONDS` and `MAX_GROSS_LEVERAGE`
from that pair. Set those values together with the snapshot hash/path so service
limits agree with the reviewed policy and mirror report lifetime.

Preparation enforces the ten-minute schedule, HTTPS endpoints without embedded
credentials, at most four multi-DEX source spot checks (14 HTTP calls including
snapshot and executor), and at most 500 bps deviation. This follows the current
multi-DEX workflow; ten spot checks would exceed its request budget.

If a normal write fails, the writer attempts to restore both previous artifacts,
including removing a newly created live file. It aborts before writing if the
mirror configuration changed after preparation. A rollback failure is explicit.
This is an offline preparation tool: do not run simultaneous freeze writers or
serve these files while changing them. Process death can interrupt the two-file
write. Inspect both hashes before committing/deploying after any interruption.
No hosted service or production workflow is updated by local preparation alone.

### Order write-ahead journal and restart recovery

Before every leverage update and every IOC order batch, the executor writes a
`dispatching` record to `executor_order_batches`. It includes the report id, exact
planned orders, deterministic client order IDs, and leverage details where
applicable. Only after the exchange response is received does the executor mark the
record settled. A lost response is marked uncertain when possible; if the process
crashes first, the durable record remains dispatching.

At startup, the executor checks unresolved records and persists a pause before
opening its listener. It also checks before each report in case an action becomes
uncertain while the process is already running. It pauses and reports the batch IDs.
The authenticated operator endpoint `GET /admin/order-batches` lists those records
and their client order IDs. For each order, query Hyperliquid's `orderStatus` by
client order ID for `HL_ACCOUNT`; compare returned status with fills and current
positions. A response `unknownOid` alone is not enough to conclude no fill. For a
leverage record, inspect the account's current market leverage. Keep the executor
paused while evidence is incomplete.

After reviewing a batch, record the operator and evidence with
`POST /admin/reconcile-batch` and JSON `{ "id": "<batch-id>", "evidence": "<what was checked>" }`.
This records a human attestation; the service does not independently verify the
exchange evidence. Reconciliation acquires the executor's shared execution lock, so
it waits for a healthy active run to finish. Still stop/fence every executor instance
and confirm the originating process cannot still be inside an exchange request before
reconciling: a lost database connection can release its lock while that process is
still alive. Clearing a live `dispatching` row could erase the recovery signal while
the request is still in flight. Reconciliation keeps the executor paused. Only after every
uncertain action has been reviewed should an operator explicitly call
`POST /admin/resume`. Never replay the old report. The next fresh report sizes from
the current account state.

Apply `20261006180000_executor_order_journal.sql` before deploying this executor.
Postgres tests must apply both mirror and journal migrations. The journal narrows
the crash window to the durable write itself, but it cannot make Hyperliquid and
Postgres one atomic transaction. Database outage during dispatch prevents sending
before the journal exists; outage after dispatch leaves the durable row unresolved
or a failed executor run, which requires operator review. A Postgres advisory lock serializes execution across service instances. If the
lock cannot be acquired, the report is not dispatched; check the active instance
and wait for the next fresh mirror report.

### What the CRE tutorials establish

The official CRE bootcamp video walks through a trigger/capability workflow and
ends with a Sepolia testnet write. That is a useful integration pattern for the
review and mirror workflows; it does not validate exchange-side crash recovery
or funded trading. Chainlink's current CRE overview says trigger executions are
independent and stateless, and local simulation can make real API and public EVM
calls. We therefore keep trading idempotency and recovery in our durable executor
store, and treat CRE simulation as an integration check that may touch live read
endpoints—not as proof of DON deployment behavior or a substitute for a testnet
soak.

For the exchange side, Hyperliquid documents `orderStatus` lookups by client order
ID and returns `unknownOid` when the ID is missing. Reconciliation must also check
fills and current positions before an operator records evidence and resumes.

References: [CRE Bootcamp Day 1 video](https://www.youtube.com/watch?v=pLAttM7-UTA),
[CRE execution and simulation model](https://docs.chain.link/cre/overview),
[Hyperliquid order-status API](https://hyperliquid.gitbook.io/Hyperliquid-docs/for-developers/api/info-endpoint).

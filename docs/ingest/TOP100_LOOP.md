# Top 100 ingestion loop

The local worker selects 100 accounts with the repository's unchanged strict Score, refreshes them from the official Hyperliquid API every ten minutes, publishes one complete batch, and ranks the stored registry for the next cycle. CRE can submit the same idempotent job and verify its published receipt in a native local simulation.

## Data flow

```text
20,869 first-pass portfolio responses
  -> 10,987 regular research candidates
  -> known Score failures excluded; missing order/classification evidence fetched
  -> scoreCandidates(inputs), default config, allowUnknown: []
  -> 100 highest-ranked eligible acquisition accounts
  -> official API refresh -> durable batch -> strict Score -> next 100
  -> small immutable receipt -> CRE HTTP + consensus simulation
```

The acquisition list contains 100 ranked accounts. Score's separate clone-grouped trading finalists remain at the existing default of 25. Neither the Score formula nor its thresholds are changed.

### Evidence bootstrap: once for this cohort

* Start only with `decision: candidate` from the complete research screen. Risk-review/watch/skip accounts are outside this cohort.
* Reject candidates that already fail an observable default Score filter, before paying to fetch more evidence.
* Fetch `userFillsByTime` ending at the portfolio's actual timestamp. Count distinct `(coin, oid)` pairs with positive filled size. Partial fills of one order count once. Ten observed orders prove the minimum; a smaller response leaves `tradeCount: null`, because the API is not a complete lifetime archive.
* If old fills have aged out, try recent `userFills`. Accept newer evidence only after refreshing the portfolio and checking fill times against its new endpoint.
* Reuse the existing classifier: known HyperCore vault list, otherwise HyperEVM code and ERC-4626 probes. RPC failure is an error, not evidence of a trader. The contract-probe classifier is a heuristic; an ERC-4626 contract's unverified closure state remains unknown and fails strict Score.
* Save raw response strings, SHA-256 hashes, classification results/block numbers, times and per-account outcomes. Retry failed accounts on resume. Do not manufacture missing values or enable `allowUnknown`.

The bootstrap uses the owner's existing personal QuickNode endpoint, read opaquely from a local credential file. It limits aggregate requests to 10 starts/second and respects provider backoff. Credentials and personal endpoint hostnames are excluded from the shared dataset. Classification records retain the classifier outcome and block, not raw RPC response bodies.

### Each ten-minute cycle

1. Freeze the prior strict Top 100 selection under a UTC ten-minute bucket ID (`ingest-<bucket seconds>`).
2. Fetch a fresh `portfolio` for each address from the **official** API. Reuse the saved order proof; refresh classification after 24 hours. Known vaults use a fresh official vault-list snapshot for TVL/closure. Trader funding uses the refreshed portfolio equity; the initial bootstrap uses discovery funding, as in the existing ingest adapter.
3. Validate timestamps, values and overlapping windows. Keep older dense points on the all-time PnL baseline. Quarantine conflicting old history when upstream values change.
4. Run the team's strict Score on the updated stored registry and select the next 100. Registry observations may be up to 24 hours old: this is not a simultaneous refresh of all 10,987 accounts. Accounts outside the refreshed list need a later broad refresh to remain in the ranking universe after that TTL.
5. Atomically commit exactly 100 account records, the full artifact, a small receipt, and the next selection. A failed/partial run leaves the previous complete publication intact.

The strict score inside a full batch artifact is scoped to those 100 newly collected inputs. `nextSelection` is ranked over the eligible stored registry; percentile scores from the two scopes need not match.

## Reliability and API budget

SQLite WAL and full synchronization persist evidence, jobs, progress and request reservations. An owner-fenced lease prevents two local workers publishing concurrently. Normal shutdown cancels work and releases the lease; a crash leaves a lease that expires after 90 seconds. Recent unfinished jobs resume; records older than five minutes are fetched again. A cycle has a nine-minute deadline and three attempts with a one-minute retry delay.

Each new official request attempt records its run/address/slot, request body, times, status, weight and successful or malformed-response hash. Retries remain attempts rather than additional evaluations. Complete artifacts include fixed cohort/target/code/config references and input evidence IDs. See the [Masa follow-up](MASA_SNAPSHOT_AUDIT.md) for the anomaly checks that motivated this trace metadata.

The official-client budget is 800 Info weight/minute and 80 HyperEVM RPC requests/minute, leaving headroom below the published 1,200 Info weight and 100 public RPC request limits. These reservations coordinate this database's clients; unrelated processes on the same IP still share upstream limits. A normal portfolio-only cycle costs approximately 2,000 Info weight. Fill queries reserve their maximum possible response weight and refund after the actual response is known. HTTP 429/5xx retries are bounded and respect `Retry-After`.

This is a local single-host adapter. It binds to loopback and does not replace the existing Supabase ingest tables, frozen Mirror configuration or trading executor. Moving it to a public service requires authenticated transport and a shared durable store. The worker retains its local evidence/history for auditing; monitor disk use and archive the database as part of operating it long term.

## Run locally

From `packages/backend`, after `bun install`:

```bash
bun --no-env-file src/ingest/loop/cli.ts seed \
  --db data/ingest-loop/loop.sqlite \
  --first-pass /path/to/completed-first-pass \
  --candidates /path/to/candidates.json

bun --no-env-file src/ingest/loop/cli.ts bootstrap \
  --db data/ingest-loop/loop.sqlite \
  --endpoint-file /path/to/private-quicknode-info-url \
  --rps 10

bun run ingest:loop:serve
```

The endpoint file must already contain the user's personal HTTPS `/info` endpoint. Do not commit or paste its value. Rerun `bootstrap` to resume; do not seed the same database twice. The server starts only after the complete cohort has an outcome and at least 100 accounts pass strict Score.

`INGEST_LOOP_DB` and `INGEST_LOOP_PORT` configure the worker (defaults: `data/ingest-loop/loop.sqlite`, `8790`). A process supervisor should run the server with automatic restart. The five-second local poll creates one job per ten-minute bucket; it does not fetch accounts every five seconds.

| API | Meaning |
| --- | --- |
| `GET /health` | Bootstrap progress, latest publication and latest run |
| `POST /ingest/trigger` with `{"bucket": <current UTC bucket ms>}` | Submit/replay one idempotent job; stable `202` acknowledgement |
| `GET /ingest/runs/<id>` | Job status and frozen selection |
| `GET /ingest/runs/<id>/publication` | Fixed publication pointer for that exact completed bucket; otherwise `503` |
| `GET /ingest/latest` | Small latest pointer; `503` when missing or older than 15 minutes |
| `GET /ingest/receipts/<sha256>` | Immutable receipt for a complete publication |
| `GET /ingest/artifacts/<sha256>` | Full 100-input artifact and scoped Score output |

`ingest-cycle.v1` is the local cycle envelope. Each `inputs[]` item is the existing `ScoreInput`; this is separate from the older Supabase `ingest.v1` envelope.

## CRE simulation

See [the workflow README](../../packages/cre-workflows/ingest-cycle/README.md). It performs real HTTP calls to the running worker, submits the current bucket idempotently, checks the previous scheduled bucket's receipt and reaches consensus on a small acknowledgement. The fixed bucket prevents node-local `/latest` lookups disagreeing during a publication. It does not recompute Score or independently attest to Hyperliquid's data.

Collection is asynchronous. Simulate once the previous scheduled bucket has a complete publication; on startup this can require waiting for the next ten-minute boundary. CRE verifies that fresh complete batch while acknowledging the newly requested job. The result names both IDs explicitly and fails if the required previous bucket is unavailable.

## Verification

```bash
# packages/backend
bun run typecheck
bun test

# packages/cre-workflows/ingest-cycle
bun run typecheck
bun test
```

Tests cover interrupted/resumed batches, concurrent ownership, failed-cycle publication, duplicate buckets, response integrity, stale data, revised history, fill counting, vault closure and budget/backoff. Live timing and native CRE simulation results are recorded separately; unit fixtures do not stand in for those checks.

Sources: [Hyperliquid limits](https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/rate-limits-and-user-limits), [CRE quotas](https://docs.chain.link/cre/service-quotas), [QuickNode Hyperliquid endpoints](https://www.quicknode.com/docs/hyperliquid/endpoints).

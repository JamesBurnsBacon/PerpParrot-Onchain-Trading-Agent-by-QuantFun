# PerpParrot 🦜

PerpParrot screens Hyperliquid traders and HyperCore vaults, reviews candidates with
an AI committee, and copies an approved roster's positions every ten minutes.

**TOKEN2049 Origins Hackathon:** AI x Crypto and NOWNodes Multichain Infrastructure
Challenge. [Dashboard](https://perpparrot.vercel.app/) ·
[Documentation map](docs/README.md) · [Operations](docs/ops/RUNBOOK.md).

This page describes the checked-in implementation. Deployed configuration and run
results must be checked separately. Paper results and successful dry runs do not
establish funded returns or predictive edge.

## 1. Scope

The application operates on the team's own account. It does not manage visitor
funds, deposit into lending vaults, or promise returns. Parrot chat saves pending
simulation requests and cannot authorize trades. Chainlink CRE and its infrastructure
were removed; historical branches and commits describe a superseded design.

## 2. Terminology

| Term | Meaning |
| --- | --- |
| Source wallet | A trader or HyperCore vault account whose positions contribute to targets |
| Bench | Recently reviewed, approved candidates available for roster admission |
| Roster | Persistent wallet seats with fixed admission weights, tenure and exit rules |
| Frozen configuration | Validated, hashed sources, weights, account and policy for a roster version |
| Exposure | Target notional divided by our equity, netted per market |
| Paper book | Simulated holdings and costs derived from the same snapshots as executor targets |

## 3. Architecture

```text
Leaderboard + vault discovery → stored portfolios/fills → Score → AI review
                                                            ↓
                                                     approved bench
                                                            ↓
                                                      roster seats
                                                            ↓
                                                active frozen configuration
                                                            ↓
NOWNodes / Hyperliquid reads → positions snapshot → target exposures
                                                            ↓
                                   executor checks → dry-run or exchange orders
                                                            ↓
                                      Supabase runs/evidence → dashboard
```

Selection, snapshots and execution use our services. Models are not called inside a
mirror execution run. See [the integration map](docs/agents/PRODUCTION_INTEGRATION.md).

## 4. Components

### 4.1 Ingest (backend)

`packages/backend/src/pipeline/` scans leaderboard traders and HyperCore vaults
at 00:15 and 12:15 UTC. Refresh runs every five minutes within its request budget;
Score qualifies up to 250 distinct accounts and selects up to 25 every ten minutes.
High-frequency accounts (>100 distinct orders/day in the observed fills) are excluded
from picks. State is in Supabase `pipeline_accounts` and `selection_runs`.

Portfolio and fill reads use Hyperliquid. Supported Info reads, including positions,
can use NOWNodes with official fallback (§5). An optional HyperEVM code check records
contract presence; it does not prove ERC-4626 compliance or identify a trading vault.
The production kind labels are trader and HyperCore vault. The shared Score contract
also supports ERC-4626 inputs, but discovery does not implement `asset()`/`totalAssets()`
classification. A denser daily historical archive remains research work: current
pipeline Score inputs use `history: null`.

[PIPELINE.md](docs/ingest/PIPELINE.md) defines jobs, freshness and cold-start behavior.
The [October 6 screening](docs/ingest/RESEARCH_SCREENING_V1.md) is separate research.

### 4.2 Score (backend)

The pure scorer builds up to 90 days from `month` and `allTime` history. Hard filters
cover account value, active history, recent activity, trade count, closed state,
month-point count, data coverage and ruin. Missing filters fail closed except for
explicitly allowed unknowns (trade count during initial qualification).

Eligible accounts rank within trader/vault pools on Sharpe, Sortino, Calmar,
negative maximum drawdown and equity-curve consistency, with weights 1, 1, 1, 1, 2.
Consistency is the log-equity trend's R² (zero for a downward trend), not positive-day
frequency. Known maker share below 5% incurs a 0.02 score penalty; unknown share is
neutral. Linked/correlated clones are grouped before proportional finalist selection.
These are configured heuristics, not a probability of future profit.

Exact math and provisional defaults: [Score specification](packages/backend/src/score/SPEC.md).
Evaluation limits: [SCORING_EVALUATION.md](docs/agents/SCORING_EVALUATION.md).

### 4.3 Buckets

| Bucket | Exposure relative to Aggressive | Execution |
| --- | --- | --- |
| Aggressive | ×1 | Only bucket eligible for live execution |
| Balanced | ×0.5 by default | Paper |
| Conservative | ×0.25 by default | Paper |

All use the same roster. The counted-gross cap is applied before these multipliers.
The current paper service creates $470 and $10k copies and BTC benchmarks; these are
configured simulation starting amounts, not a statement of the funded account balance.

### 4.4 Copy model

`packages/shared/copy.ts` derives targets from each source's frozen weight and signed
notional/equity. Where measured leverage is available, the source is normalized by
`2 / max(averageLeverage, 0.05)`. A flat source contributes zero; its weight is not
redistributed. Wind-down caps prevent following new entries/increases from exiting seats.

The pipeline policy caps counted gross at 5×: majority-side exposure plus half the
minority side after netting per market. Each source is capped, then the combined book.
At most 15 perps remain, with target scaling preserving counted gross. Closes normally
require three consecutive zero-target runs. Ineligible-market closes and manual
flatten bypass that waiting rule.

Tradable markets are cross-margin validator perps and supported USDC-collateral HIP-3
markets. The backend uses $20M entry / $15M exit open-interest hysteresis; the executor
also checks markets independently. Eligibility is refreshed daily; counts vary.

### 4.5 Source-set changes

The source set can evolve through [ROSTER.md](docs/ingest/ROSTER.md). Seats target
12–15 wallets, with at least five to activate a configuration. Fixed admission weights,
12–72-hour tenure, at most two admissions/hour and eight/day, and a 24-hour cooldown
limit rotation. Copyability checks apply before admission.

Flat seats release after the specified confirmation/idle period. Warning signs wind
seats down, following reductions and exits for at most 48 hours. A 50% trading loss
since admission removes a seat; the account's remaining close still follows the normal
confirmation rules. Changes are frozen and activated by the roster job, not directly
by model prose or a wholesale replacement after every selection.

### 4.6 AI layer: the review committee

Pipeline selection builds measured evidence, then invokes Role, Risk and Red-Team
through `openAIPaperCommittee` and `runCommitteeReview`. `REVIEW_MODEL` configures the
server-side provider model. Outputs, gate, summaries and receipt/audit data are persisted
in `selection_runs.review`; approved wallets populate the bench.

A VALID core manifest takes the strict path. With `REVIEW_GATE=basic` (default), only
`INSUFFICIENT_EVIDENCE` permits the basic approval fallback. Other invalid reasons
approve nobody. An incomplete seat re-review preserves seats and retries later.
The roster applies its own admission and configuration checks. See
[the review contract](docs/agents/INTEGRATION.md) and [gate history](docs/agents/BASIC_GATE_FALLBACK.md).

### 4.7 Mirror runs (every 10 min, at :x0)

1. Vercel's `:x9` cron pre-builds the upcoming immutable positions snapshot. Equity
   comes from the live `day` portfolio value; positions follow configured read routing.
2. `targetsFromSnapshot` produces exposures, pending closes and configuration evidence
   at `/api/backend/targets/:runAt`; the same snapshot feeds paper books.
3. The long-running executor triggers `:x0`, claims the slot and checks account and
   configuration before planning. Duplicate triggers are no-ops.

When present, the validated active Supabase configuration is authoritative; the pinned
file/hash is the bootstrap fallback. There is no onchain freeze contract. Operator
freeze tools are separate from automatic roster activation. Failures are recorded and
alerted; they do not authorize a different configuration or fabricated data.

### 4.8 Execute (executor service)

`packages/executor` sizes exposures with current equity and plans against actual
positions. The margin cap is 95%; ordinary adjustments require a $10 gap, 10% of target
and 0.5% of equity. It checks eligible markets, rounding and minimum order value.
Orders are IOC limits at mark ±50 bps by default, with deterministic client order IDs.
The raw-gross sanity bound defaults to 10×; it is separate from the 5× counted-gross policy.

Dry run is the default. Live trading requires `DRY_RUN=false`, an authorized API-wallet
key and one long-running process; Vercel refuses live mode. Claims, locks and a durable
order journal protect runs. Ambiguous exchange results are reconciled before further
orders on affected markets. Pause/resume/flatten are authenticated operator actions;
only a human pauses or flattens. See [RUNBOOK.md](docs/ops/RUNBOOK.md).

### 4.9 Backtest (research)

Read-only research tools live in `packages/backend/src/backtest/` and
`scripts/research/`. The dated [backtest](docs/agents/REAL_DATA_BACKTEST.md) and
[feature study](docs/agents/FEATURE_DISCOVERY.md) include negative findings and capture
limitations. A completed multi-window algo/model-A/model-B comparison after costs is
not established. Optional dashboard artifacts appear only when actually published.

### 4.10 Paper books (backend only)

`packages/backend/src/paper/` steps copy and BTC books from snapshots, marks, fees,
slippage and funding, persists them, and serves `/paper`. Returns and turnover are
simulated. There is no default competing-model shadow book. A roster fresh start
archives prior paper state and points before restarting books; it does not erase
executor evidence. See [CHURN.md](docs/ingest/CHURN.md) for dated replay measurements.

### 4.11 Dashboard and Parrot

The dashboard reads service endpoints for paper books, live runs, target/held exposures,
pipeline finalists and roster state. Historical backtest/funnel artifacts are optional;
absence is not replaced by invented results. Per-source exposure attribution is not
per-source realized PnL. Pause/Flatten remain on authenticated executor endpoints.

[Parrot](docs/parrot/README.md) provides conversational wallet exploration and sentence
receipts. Confirmation saves a PENDING simulation request. It cannot trade or alter the
active roster. Its read-only run card is omitted when the latest run has no orders.

### 4.12 Module contracts

| Module | Input | Persisted output / API |
| --- | --- | --- |
| Ingest / Score | discovery, portfolios, fills | `pipeline_accounts`, finalist evidence in `selection_runs` |
| Review | measured finalist evidence | `selection_runs.review`, approved bench |
| Roster | bench, seat observations and reviews | `roster_seats`, `roster_events`, active `configurations` |
| Snapshot / targets | active configuration, source state | `run_snapshots`, `/targets/:runAt` |
| Executor | targets and own account | claims, `executor_runs`, order journal, `run_targets` |
| Paper | snapshot and market data | `paper_state`, `paper_points`, `/paper` |
| Dashboard / Parrot | read endpoints and bounded conversation | UI; pending `strategy_requests` only for Parrot saves |

### 4.13 Run record and how to check it

Fetch `/api/executor/runs`, inspect status, `dryRun`, results and evidence. Hash the
exact bytes of `/api/backend/snapshots/:runAt` with Keccak-256 and compare with
`evidence.snapshotHash`. Recompute exposures with `targetsFromSnapshot`; configuration
hash and account must agree. A successful zero-order run is not a funded fill.
`rebalance-report.schema.json` is a review-core contract fixture, not executor transport.

### 4.14 Hosting and scheduling

One Vercel project serves dashboard `/`, backend `/api/backend` and executor read/dry-run
endpoints `/api/executor`. Supabase holds shared state. The root `vercel.json` schedules
scan twice daily, refresh every five minutes, select at `:x4`, roster at `:x6`, snapshots
at `:x9`, and watchdog every five minutes. It does not schedule executor `/cron/run`.
The long-running executor (Railway configuration supplied) triggers `:x0` itself.

## 5. NOWNodes integration

The existing backend router supports `official`, `overflow` and `split`. Defaults are
official-only. `INFO_ROUTING=split` and `INFO_SPLIT_PERCENT=100` make supported reads
NOWNodes-first with official fallback; `NOWNODES_API_KEY` stays server-side.
Portfolio, fills and exchange orders remain on Hyperliquid.

Supported routing methods: `meta`, `perpDexs`, `clearinghouseState`,
`spotClearinghouseState`, `webData2`, `userVaultEquities`, `spotMeta`, `vaultSummaries`.
The optional capability probe can narrow this list. Contract checks, the overlap guard,
shadow reads and snapshot verification are separate switches. Keep snapshot verification
off with NOWNodes-first reads: its second reader is also NOWNodes.

NOWNodes supplies an additional read channel, not a latency improvement. A local
same-account benchmark on October 7 (10 measured reads/provider after one warm-up)
measured median complete-response latency of 271 ms through NOWNodes and 93 ms through
the official API; all measured calls succeeded without fallback. These are local
observations, not Vercel latency or an SLA. Current deployment evidence comes from
`/api/backend/pipeline` routing counters, which are per process and reset on cold starts.

Flags, rollback and independent-provider checks: [DEPLOY.md](docs/ops/DEPLOY.md).
Historical provider observations: [research notes](docs/research/OBSERVATIONS_20261006.md).

## 6. Verification

Use Node 24 and Bun 1.4.2 (the service CI version):

```sh
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test
(cd packages/backend && bun install --frozen-lockfile && bun test && bunx tsc --noEmit)
(cd packages/executor && bun install --frozen-lockfile && bun test && bunx tsc --noEmit)
(cd packages/dashboard && bun install --frozen-lockfile && bun test && bun run build)
./scripts/e2e-mirror.sh all
```

Install shared runtime dependencies with `bun install --frozen-lockfile --cwd packages/shared`
before service checks on a fresh checkout. Use an isolated local environment for E2E:
no production database, wallet keys or alert credentials. The script forces dry-run
execution. Database-specific tests require a disposable `TEST_DATABASE_URL`; CI supplies
PostgreSQL. Model/provider and browser microphone acceptance are separate checks.

## 7. Limits and operational risks

- Leverage caps, margin checks and IOC limits reduce some risks; they do not eliminate
  liquidation, slippage, stale data or tracking error.
- Models score bounded evidence; committee approval is not proof of profitable copying.
- A working pipeline and a short live window do not validate a strategy's long-term returns.
- Minimum order sizes and delayed entry/exit prevent exact copying at small account sizes.
- Repository, deployment and operator access can change trading behavior; keep credentials
  server-side and review configuration changes with the account owner.

## 8. Remaining work and evidence

Multi-window strategy evaluation, a denser historical universe, sustained performance
and real-microphone/browser acceptance require their own evidence. Balanced/Conservative
live accounts and ERC-4626 classification are not implemented product paths. Current
operational procedures are in [DEPLOY.md](docs/ops/DEPLOY.md) and
[RUNBOOK.md](docs/ops/RUNBOOK.md); historical research and pitch captures are indexed in
[docs/README.md](docs/README.md).

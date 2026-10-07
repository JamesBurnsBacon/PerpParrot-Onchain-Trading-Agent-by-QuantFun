# Source scoring: current behavior and evolution gate

## Current score

`packages/backend/src/score/score.ts` applies eligibility filters, computes metrics over
the configured stitched lookback (up to 90 days by default), and ranks eligible addresses by weighted percentiles of Sharpe, Sortino,
Calmar, negative maximum drawdown and log-equity trend R² consistency (weights 1, 1, 1,
1, 2). A known maker share below the configured threshold incurs the configured
pure-taker penalty; unknown maker share is neutral. Integer ranking and deterministic
tie-breaking are implemented in `score.ts`. This is a **relative shortlist**, not a
probability of future profit or a live allocation weight. Leverage and holding-time
evidence also feed the later review and roster checks.

`packages/backend/src/pipeline/index.ts` calls `scoreCandidates` for qualification
and selection. It reads persisted `pipeline_accounts`, writes `selection_runs`, and
feeds measured evidence to the committee. Vercel Cron schedules these jobs; see
[the production pipeline](../ingest/PIPELINE.md). These operational tables do not
constitute an immutable historical universe or prove predictive performance.

## Evidence limits to respect

Hyperliquid's [`portfolio` Info endpoint](https://hyperliquid.gitbook.io/Hyperliquid-docs/for-developers/api/info-endpoint)
exposes account-value and PnL histories, but Hyperliquid says its portfolio graph data
is sampled every 15 minutes and around deposits/withdrawals, and is not recommended for
precise accounting ([portfolio graphs](https://hyperliquid.gitbook.io/hyperliquid-docs/trading/portfolio-graphs)).
Keep this score at the screening layer. Reconcile PnL, fees, funding, deposits,
withdrawals, and copy-execution outcomes in a separate point-in-time replay before
changing eligibility or selecting a live set.

The checked-in portfolio fixture is useful for parser and regression tests; its
addresses are synthetic aliases and some metadata is synthetic. It is not a historical
universe suitable for claiming predictive edge. A current leaderboard replay also
cannot recover sources that later closed or disappeared.

## Evolution process

Treat every scoring change as a challenger against a pinned baseline:

1. Freeze the baseline code, configuration, prompt/review version, and input cutoff.
   Give each score rule a version before it is used in persisted results.
2. Build point-in-time snapshots of the full eligible source universe, including
   sources that later close or disappear. Each row needs an `asOf` time, raw evidence
   provenance, schema version, and a reproducible source-to-address mapping.
3. At each cutoff, compute scores using only data available then. Select the shortlist,
   then measure future source outcomes in disjoint 2-week, 1-month, 6-week, and 3-month
   windows. Do not let the future window influence filters, percentiles, source
   inclusion, or parameter choice.
4. Replay the actual 10-minute copy delay, asset netting, fees, funding, slippage,
   minimum order size, lot/tick rounding, position limits, and failed/unavailable data.
   Compare to the pinned baseline and a BTC benchmark. Report net return, drawdown,
   turnover, concentration, capacity, missed fills, and source-set churn.
5. Run sensitivity tests for candidate-cohort additions/removals, missing histories,
   stale data, closed sources, outlier gains, flat periods, source kind, and small
   changes in cutoff time. A good score should not win only under one cutoff or one
   surviving cohort.
6. Keep hard eligibility and risk vetoes outside the relative score. Never offset a
   liquidation, leverage, history-quality, or execution-fit failure with a high return
   percentile.
7. Promote a challenger only when it beats the pinned baseline across multiple
   disjoint forward windows after costs, with uncertainty reported and no material
   safety-regression. Otherwise retain the baseline and record the negative result.

Do not tune weights using the same windows used to report performance. Keep the search
budget and every tested variant: repeated experimentation creates selection bias even
when the final formula looks simple.

## Engineering lessons

The repo keeps bounded model judgment separate from allocation: models score evidence,
while local deterministic code validates and allocates. For agent quality, follow the
task-specific evaluation principle in Anthropic's
[Building Effective Agents](https://www.anthropic.com/engineering/building-effective-agents):
use focused, composable steps and evaluate against clear outcomes. In this project,
LLMs can assess qualitative source evidence, but deterministic score logic, constraints,
and out-of-sample replay must decide whether that evidence can influence eligibility or
allocation.

## Current verified scope

- Unit tests cover parser boundaries, filter behavior, finite arithmetic, metric
  fixtures, ties, integer percentile arithmetic, order invariance, finalist caps, and
  malformed trade counts.
- A score run over test fixtures is a regression check only. It is not a real-time
  leaderboard run, a point-in-time backtest, or a deployment check.
- Scheduled score-to-review orchestration and persistence are implemented in the
  backend pipeline. Verify deployment health from current pipeline/roster status and
  run evidence; unit tests alone cannot establish that a deployed cron ran.
- An immutable historical universe and multi-window challenger replay remain separate
  research evidence requirements. A working production pipeline does not establish
  investment quality.

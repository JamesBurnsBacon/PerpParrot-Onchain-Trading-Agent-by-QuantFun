# Public-data backtest: first screening evaluation

## What ran

On 2026-10-06, a read-only collector sampled 12 accounts from Hyperliquid's public
leaderboard using seed `20261006`, requiring only current account value of at least
$10,000. It fetched each account's public `portfolio` history, retained raw histories
and response SHA-256 hashes, and ran the existing `rankByMetrics` scoring formula.
Training ended at 2026-09-22 12:40:54 UTC. The holdout ended at the earliest latest
observation in the accepted cohort, 2026-10-06 12:40:54 UTC. The backtest excluded any
portfolio interval that straddled the shared cutoff.

The five selected sources had a **-3.70% median held-out source return**; the full
12-source cohort median was **-3.58%**, or **-11.8 bps relative**. This small, single
sample does not show a positive ranking effect. Several selected sources had negative
holdout returns, and an unselected source was among the best performers. Treat that
as a useful warning against promoting current score output, not as a statistically
meaningful estimate of future performance.

The original capture is local-only at `work/backtests/public-20261006-v2.json`
(ignored by Git). It is not included in a fresh clone, so the reported historical
numbers cannot be independently reproduced from this repository alone.
It contains the sampled addresses, raw monthly series, request hashes, rejected
requests, methodology, and per-source training/test results. It is a point-in-time
capture of public data, not a historical candidate-universe snapshot.

## Run it again

From the repository root, run `bun run packages/backend/src/backtest/fetch-public.ts`.
This collects a new public-data sample; it does not recreate the historical capture.
Optional environment variables are `BACKTEST_SAMPLE_SIZE` (7–100, default 40),
`BACKTEST_FINALISTS` (default 5), `BACKTEST_SEED` (default `20261006`), and
`BACKTEST_OUTPUT`. The collector only calls the public leaderboard and Hyperliquid
Info `portfolio` endpoint. It does not require a key or call exchange write endpoints.
Keep each generated artifact; do not overwrite prior runs when comparing score
changes.

## What this does and does not test

It tests whether the current numeric source rank has any cross-sectional association
with later observed account PnL in this one short holdout. It uses the same scoring
metrics and deterministic rank ordering as the scorer, with a shared cutoff and a
gap-safe held-out return calculation. It fails on malformed histories, stale data,
duplicate addresses, insufficient observations, or undersized cohorts.

For the statistical design, I followed the
[QuantConnect research guidance](https://www.quantconnect.com/docs/v2/writing-algorithms/key-concepts/research-guide):
freeze the rule, keep later data unseen during ranking, and require repeated forward
windows before trusting a result. This first run only implements one cutoff; the report
does not claim to satisfy the multi-window gate.

It does not simulate the product strategy or justify real allocations. Hyperliquid's
portfolio graphs are sampled and are not an accounting ledger; deposits, withdrawals,
sampling gaps, and partial data may distort returns. The cohort comes from today's
leaderboard, so it has survivorship and selection bias. This run omits address
eligibility checks that require historical closed/trade-count evidence. It also omits
actual 10-minute delayed fill replay, order netting, fees, funding, slippage, minimum
order size, rounding, position limits, liquidity/capacity, and liquidation behavior.
The API's `userFillsByTime` history is capped at 10,000 recent fills per account, so a
full replay needs a separately validated archive source and starting-position ledger.

The next evidence gate is not tuning weights against this sample. Start scheduled,
immutable snapshots of the entire candidate universe (including sources that leave
the leaderboard), fill/funding/ledger events, and market prices. Then build delayed
paper replay with accounting reconciliation and costs, evaluate across multiple
disjoint cutoffs, and preserve this run as the pinned baseline. No score change should
be promoted based on this result.

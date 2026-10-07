# Public feature discovery: empirical review

## Question and scope

This study asks whether public Hyperliquid activity fields omitted from the current
source score contain useful *candidate* information about subsequent account returns,
and whether public ledger events reveal direct links between candidate accounts. It
does not claim that institutional firms overlook these fields; that cannot be inferred
from public APIs. “Underused” here means fields not represented in this repository's
current score.

The work is research-only. No feature from this study changes source ranking, review
consensus, allocation, or execution. No exchange write endpoint was called.

## Data and frozen split

For this run, a read-only collection drew a deterministic random sample of 80 addresses from the current
public leaderboard, filtered to account value of at least $10,000, then applied only
pre-cutoff data quality/activity requirements: at least nine monthly equity points
before the training period, at least $10,000 starting equity, and at least ten fills
in the preceding 14-day training window. It did not filter on training or holdout
return. Forty-four passed the initial screen; one nonpositive-equity history was
rejected, leaving 43. Five of those 43 had fill history capped at 2,000 records, so
fill-derived fields are marked unavailable for those sources rather than treated as
zero. Funding and non-funding ledger records were recursively split into bounded time
windows and complete for all 43 analyzed sources.

The training window ended at **2026-09-22 12:40:54 UTC**. The held-out account-graph
window ended at **2026-10-06 12:40:54 UTC**. One source with invalid/zero equity was
rejected by the existing backtest. The current score selected five sources whose
median held-out return was **-3.7167%**, compared with **-2.9315%** for the 43-source
cohort (about **-78.5 bps** relative). Only 12 of 43 had positive held-out returns.
This is a negative diagnostic for the existing ranking on this window, not a stable
performance estimate.

The expanded cohort was assembled after an earlier 12-wallet result on the same
market dates had already been inspected. The two results are therefore not
independent confirmation. Both cohorts come from today's leaderboard and are
survivorship/selection biased. Do not use either result to tune or promote weights.

## Features and observed associations

`source-features.ts` computes descriptive, pre-cutoff fields from public fills,
funding, and ledger records. It deduplicates events, enforces event timestamps inside
the requested window, treats unknown denominations as missing, separates settlement
records from ordinary market executions, and leaves capped fill features null. Fields
include turnover/equity, maker share, USDC fee basis points, asset concentration and
count, net funding/equity, settlement count/PnL, and public transfer-network measures.

The exploratory analysis calculated Spearman correlations against later source
returns, 20,000 two-sided wallet-label permutations per feature, and Benjamini-Hochberg
q-values across the tested features. The original output is local-only at
`work/backtests/active-feature-exploration-20261006-v2.json` (ignored by Git).
It is not shipped with this repository; the historical numerical results below
require that capture for independent reproduction.

| Training feature | Sources | Spearman rho | Permutation p | BH q | Reading |
| --- | ---: | ---: | ---: | ---: | --- |
| Net funding / starting equity | 43 | +0.513 | 0.00070 | 0.0091 | Strongest candidate relationship; investigate, do not trade |
| Asset notional HHI | 38 | +0.285 | 0.0879 | 0.505 | Weak, uncertain concentration relationship |
| Log asset count | 38 | -0.259 | 0.1165 | 0.505 | Weak, uncertain breadth relationship |
| Log turnover / equity | 38 | -0.214 | 0.1923 | 0.625 | No supported relationship here |
| Maker notional share | 38 | +0.095 | 0.5720 | 0.826 | No supported relationship here |
| Fee bps / notional | 23 | -0.050 | 0.8191 | 0.839 | Too much denomination missingness for confidence |
| Settlement count | 43 | -0.062 | 0.7935 | 0.839 | No supported relationship here |
| Ledger / transfer fields | 24–43 | weak | >0.30 | >0.71 | No supported relationship here |

Funding's leave-one-source-out rho remained between **+0.478 and +0.599**. That rules
out a single-wallet explanation for this sample, but it does not resolve common market
exposure, wallet dependence, the search over features, or the fact that the training
and outcome windows are adjacent parts of one market regime. The reported permutation
test assumes wallet rows are exchangeable; shared market shocks violate that assumption
and can make nominal p-values too small. BH adjustment handles a feature family under
its assumptions, not clustered observations, post-hoc selection, or unrecorded prior
experiments. Net funding may also reflect positions, exposure, and realized strategy
style rather than a causal mechanism. We do not know whether the relationship survives
asset/market-beta, leverage, position-duration, deposits, and fees/slippage controls.

The feature was derived from public funding records, which are hourly transfers between
traders and the venue. Settlement records were also discovered in the fill endpoint;
they can have zero or nominal price and carry `closedPnl`, so this implementation keeps
them out of market notional, maker/taker, and turnover calculations. This is a data
quality improvement, not evidence that settlement behavior predicts future returns.

## Address relationships: do not confuse infrastructure with identity

The analyzed ledgers contain **no direct transfers between two cohort accounts**.
The simple shared-counterparty graph nevertheless emits 58 wallet pairs. Its most
common addresses are `0x2000…0000` (8 source accounts),
`0x6b9e…0a24` (8), and `0x2222…2222` (3). These common nodes dominate the naïve graph
and are consistent with protocol/system or operational transfer paths. Hyperliquid's
official [Core <> EVM transfer documentation](https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/hyperevm/hypercore-less-than-greater-than-hyperevm-transfers)
describes system-address transfer mechanics. This dataset alone does not verify the
role of every common address, including `0x6b9e…0a24`, so the graph treats them as
unclassified shared endpoints, not proof of common control, copying, wash trading, or
collusion. Address similarity must not become a punitive eligibility flag.

The next graph version should attach verified entity labels only from authoritative
contract metadata, distinguish user-to-user transfers from deposits/withdrawals and
system contracts, and preserve event direction, denomination, value, timing, and
provenance. A candidate link should require repeated reciprocal/value-bearing
transfers after known protocol endpoints are removed, followed by manual review. With
43 wallets and a short window, this is lead generation, not entity resolution. The
qualified cohort/event capture was a one-off research collection; the repository
contains feature derivation and analysis, but not a reusable end-to-end collector for
this cohort. Reproducible capture remains a required follow-up.

## Knowledge translated into the research process

I reviewed the publisher's video catalog by Marcos López de Prado, including [Can AI
Help Discover Causality in Finance?](https://www.youtube.com/watch?v=OxvFM6oBTMA) and
[Machine Learning for Portfolio Construction](https://www.youtube.com/watch?v=Dor6umkfBt8).
The catalog describes the former as a lesson in causal reasoning and the conditions
needed for AI-based causal discovery; it describes the latter as combining ML, graph
theory, and random matrix ideas to address portfolio optimization instability. I
could verify the publisher catalog and video metadata, but not a reliable full
transcript, so I do not attribute specific spoken claims beyond those catalog
abstracts. The practical translation here is to label links as hypotheses, separate
association from causal claims, account for selection/search, and require frozen,
repeated out-of-sample tests before promoting any feature. See the [publisher's video
catalog](https://www.quantresearch.org/Videos.htm) and Bailey et al.'s primary
[Probability of Backtest Overfitting paper](https://www.davidhbailey.com/dhbpapers/backtest-prob.pdf).

The data choices follow the venue's own limits: `userFillsByTime` returns at most
2,000 records per response and only the most recent 10,000 are available, according to
the [official Info API documentation](https://hyperliquid.gitbook.io/Hyperliquid-docs/for-developers/api/info-endpoint).
Hyperliquid cautions that [portfolio graphs](https://hyperliquid.gitbook.io/hyperliquid-docs/trading/portfolio-graphs)
are sampled and include deposit/withdrawal events. These endpoints are suitable for
screening and feature research, not a reconciled copy-trading ledger. For modeling,
official [perpetual Info API field definitions](https://hyperliquid.gitbook.io/Hyperliquid-docs/for-developers/api/info-endpoint/perpetuals)
and [funding documentation](https://hyperliquid.gitbook.io/hyperliquid-docs/trading/funding)
are the field semantics authority.

## Next experiments before any score change

1. Start immutable, scheduled captures of the full candidate universe, including
   delisted/declining sources, fills, funding, ledger updates, positions, and market
   prices; retain request times, endpoint parameters, response hashes, and completeness
   flags.
2. Pre-register net funding/equity as a candidate feature. Do not search thresholds on
   this window. Compare a baseline score against one ablation adding funding only, with
   exact same eligible sources, frozen cutoffs, and identical execution assumptions.
3. Collect multiple non-overlapping forward windows. Use wallet-clustered and
   time-blocked uncertainty estimates; evaluate cross-sectional rank stability and
   nested walk-forward selection. Include the number of tested features/variants in
   the backtest-selection correction.
4. Reconcile deposits, withdrawals, funding, fees, and position changes, then replay
   the actual 10-minute delayed mirror rule with slippage, partial fills, minimum
   notionals, rounding, liquidity caps, leverage/liquidation constraints, and gaps.
5. Promote a feature only if it improves net out-of-sample portfolio outcomes across
   predeclared windows, remains robust under concentration/correlation and stress
   tests, and passes the project's existing scorer contracts and review gates.

Until those gates pass, keep the production score unchanged and use the funding
relationship only to prioritize data collection and falsification.

## Reproduce the analysis from captured files

The raw research files are local, ignored artifacts under `work/backtests/`. Given
matching cohort, backtest, and event JSON files, run from the repository root:

```sh
bun run packages/backend/src/backtest/explore-active-cohort.ts \
  work/backtests/active-quality-cohort-20261006.json \
  work/backtests/active-quality-backtest-20261006.json \
  work/backtests/active-quality-ledger-features-20261006.json \
  /tmp/active-feature-exploration.json
```

The explorer checks that training windows match and writes with create-only
semantics. The shorthand package script uses the default paths and output name, so
retain each generated artifact or supply a new output path before rerunning.

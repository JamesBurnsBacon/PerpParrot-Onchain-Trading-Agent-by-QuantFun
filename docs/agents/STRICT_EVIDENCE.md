# Strict review: measured evidence and local checks

Builds on James's #50 and the owner decisions in #53. The frozen fixture, five-source
minimum, trading-risk thresholds and Red-Team rules are unchanged. Scheduled review
uses `packages/backend/fixtures/review-policy.json`; the basic gate remains the default fallback.

## What reaches the committee

| Field | Calculation and limit |
| --- | --- |
| `patterns.observedFills` | Unique observed perp fills in the requested 30-day window. Spot is excluded. |
| `patterns.increasesAfterLoss` | Adds at an adverse price / adds with known entry cost. Entry is reconstructed from an observed flat start; partial reductions preserve weighted cost, flips open a new episode. Carried-in positions and data gaps have unknown cost. This is an observed price comparison, not proof of martingale intent. |
| `patterns.repeatedRoundTrips` | Fully observed episodes closed within 10 minutes / all fully observed closed episodes. This is turnover evidence, not proof of wash trading. No eligible denominator means null, not zero. |
| Path sample counts | `costBasisAdds`, `closedEpisodes`, `continuityBreaks` show the support for each ratio. |
| `metrics.btcBeta` | Covariance of account and BTC daily returns / BTC return variance. Account returns reuse Score's inferred-deposit adjustment. Use completed UTC days, >=14 matched intervals, no future BTC price and no gap over an hour at BTC endpoints. Too little history or zero variance means null. This is observational exposure, not causal strategy identification. |
| `metrics.survivorshipQuality` | `CURRENT_SNAPSHOT`: this cohort excludes disappeared accounts; it is not a survivorship-free backtest. |
| `exposureByClass` | Current long/short USD totals across **all** observed core + xyz positions, before the top-12 detail cap: gold = PAXG / xyz:GOLD; oil = xyz:CL / xyz:BRENTOIL; other HIP-3 = other; remaining core perps = crypto. No position does not prove no historical trading. |

`measurement` records the requested window, BTC pair count, method version and scope.
`API_BOUNDED` means the API returned its available history, **not** proof of complete
history; `TRUNCATED` means paging hit the limit. The API exposes at most the latest
10,000 fills. A full page can cut through one timestamp; unobserved entry costs stay
unknown. [Hyperliquid API reference](https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/info-endpoint).

The committee's evidence hash includes these fields. Curves and position details
can be shortened to keep the existing 4 KB per finalist, but class totals stay intact.
No additional strategy-model call is introduced. #45's advisory worker is not imported.
The trailing seven-day windows from #50 are inside the selection lookback: they are
recent-window diagnostics, not independent out-of-sample validation.

## Run locally

From the repository root (Bun and root dependencies installed; key in ignored `.env.openai`):

```sh
mkdir -p work/strict-check
bun --env-file=.env.openai packages/backend/scripts/strict-gate-check.ts \
  --local-dir work/strict-check/database --traders 60 --vaults 80 \
  --inputs work/strict-check/inputs.json --reads work/strict-check/reads.json \
  --output work/strict-check/run-1.json --as-of '<recorded UTC timestamp>'
```

Repeat with the same timestamp/cache and a new output filename for a new real model
observation on the same public reads. Cached public responses bypass waiting; cache
misses still obey pacing. Model responses are **never** cached by this harness. This
spends API tokens. Omit caches/use a new directory for a fresh market snapshot.

`--local-dir` uses an isolated PGlite database and the existing pipeline migration.
It exercises the same SQL and review path, but does not certify Bun's network driver,
production locks or a Supabase deployment. Alternatively use a loopback `DATABASE_URL`
with the migration applied. Remote database URLs are rejected. The harness never trades.

The report separates candidate checks, pair/Red-Team/capacity results, the manifest,
and `freezeEligible` (VALID plus >=5 sources). Counterfactual threshold counts use the
**same saved Role/Risk ratings**, change no running policy and do not constitute
portfolio approval. The shared reject threshold affects both Role rejection and the
five trading risks. Any proposed threshold change still needs the owner's decision.

Private caches, model audit rows and generated reports belong in ignored `work/` only.
Commit code/tests and concise measured summaries; never commit raw account histories or keys.

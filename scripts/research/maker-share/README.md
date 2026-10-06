# Maker share vs. forward performance

Research for README §4.2 / §8 ("Maker share: a plus or an exclusion?"). Question: do accounts whose fills are
mostly maker (resting, `crossed: false`) go on to perform better than takers?

## Run

```sh
bun scripts/research/maker-share/fetch.ts --target=200            # ~25 min; cached in work/maker-share/
bun scripts/research/maker-share/analyze.ts                        # offline, seconds
bun scripts/research/maker-share/fetch.ts --target=200 --period=2  # same test one month earlier
bun scripts/research/maker-share/analyze.ts --period=2
bun test scripts/research/maker-share
```

`work/` is gitignored. Every HL response is cached there, so reruns of `fetch.ts` resume for free and
`analyze.ts` never touches the network. The analysis writes `report.txt`, `results.json` and `dataset.csv`.

## Design

- **Out of sample.** For each account, t0 is the first point of its `portfolio` month window (≈ now − 30 d).
  - Maker share comes from fills in the 30 days *before* t0.
  - The outcome is the 30 days *after* t0: flow-adjusted return (the score's `computeIntervals`), annualised
    Sharpe on a daily grid, and max drawdown.
  - Every selection rule uses only pre-t0 data.
- **Sample.** A seeded random draw from leaderboard rows with ≥ $1M all-time volume, with no filter on current
  account value. README §4.2's filters are applied *at t0*:
  - ≥ $10k account value
  - ≥ 30 days of history
  - ≥ 10 perp fills in the formation window
  - ≥ 25 month points

  Accounts that blew up after t0 therefore stay in the sample.
- **Maker share** = maker notional / total notional, perps only (validator perps and HIP-3), via
  `userFillsByTime` with `aggregateByTime`. Each half of the formation window is read as one page (≤ 2000
  fills), so heavy accounts are sampled across the window. Accounts whose page was full are flagged `capped`.
- **Tests.** All are rank based, because returns are heavy tailed:
  - Spearman ρ, with a permutation p-value and a bootstrap CI.
  - A threshold scan over maker share ≥ t vs. < t (Mann–Whitney). It reports p-values adjusted family-wise across
    all t (max-|z| permutation), because picking the best cut-off would otherwise find noise.
  - Fixed buckets.
  - A rank regression controlling for past 30 d return, account size and turnover (notional / equity / day, a
    proxy for leverage × frequency). The maker term enters either as a rank or as a pure-taker indicator (< 5%).
  - Sensitivity cuts.
- **Period 2** (`--period=2`) moves t0 back 30 days. Its forward window comes from the coarse `allTime` points
  (a few days apart), so it has no Sharpe and its drawdowns are understated. They are still comparable as ranks.

## Results (2026-10-06, seed 1, 2 × 200 accounts)

Period 1: t0 2026-09-05, Sharpe and drawdown from the fine month window. Period 2: t0 2026-07-29…08-05, coarse.

| | Period 1 | Period 2 |
|---|---|---|
| Spearman ρ(maker share, fwd return) | 0.01 (p 0.89) | 0.04 (p 0.60) |
| Spearman ρ(maker share, fwd Sharpe) | 0.12 (p 0.10) | — |
| Median fwd max drawdown, maker < 5% vs ≥ 5% | **30.0% vs 14.8%** (family-wise p 0.017) | 6.9% vs 3.4% (n.s., coarse) |
| Same, after controls (pure-taker coefficient, rank SD) | +0.26 (CI −0.01…0.52) | +0.03 (CI −0.25…0.31) |
| Median turnover (notional / equity / day), maker < 5% vs ≥ 5% | 1.12 vs 0.41 | 0.65 vs 0.34 |
| Median fwd return, maker < 5% vs ≥ 5% | 4.8% vs 5.3% | 19.3% vs 16.3% |

Outcome:
- A high maker share is **not a plus**. No threshold survives the family-wise correction for return or Sharpe.
- Zero or near-zero maker volume is a **slight negative**. Such accounts had about twice the drawdowns in both
  periods, mostly explained by about 2× higher turnover, and returns were no worse.
- Exactly 0% is not the signal alone. The 0-5% group had the largest drawdowns in both periods, so the cut is 5%.
- Implemented as the score's pure-taker penalty (`packages/backend/src/score/SPEC.md` "Ranking"):
  `pureTakerMakerShare` 0.05, `pureTakerPenalty` 0.02, both [tune].

## Known limits

- **Blind spot: the heaviest accounts.** HL serves only roughly the 10k most recent fills, so an account with more
  than that in the last 30 days has no formation fills to read. These are mostly HFT/market makers. The report
  counts them (no formation fills but ≥ $100M forward volume). The result describes copyable-size traders, not
  professional MMs.
- **Short history.** Each period is one month, i.e. one market regime. Period 2 is a second month, not a long
  history.
- **Sample size.** ~200 accounts can detect |ρ| ≳ 0.14 at 5%. A smaller effect would read as "no evidence".
- **Copyability is not tested here.** A maker's edge includes spread and rebates, which a 10-minute-delayed
  taker copy can't capture. This study only asks whether makers *themselves* do better.

# Measured data handoff

Real public observations feed the existing Score, Review, paper freeze and services.
Algorithms remain simple. Missing evidence stays unknown; collection success does
not mean Review approval.

## Two different jobs

- **Recurring ingest:** collect 100 accounts selected by the repository's strict
  Score every ten minutes. Record replacements and immutable results. Idle refresh
  rotates older candidates; quarantined accounts need a successful probe to return.
- **One-off measured rehearsal:** `collect-measured.ts` starts with **at most 25
  Score finalists from one completed Top 100 artifact**. It records fills and account
  snapshots for Review. Later ranking covers this measured subset, not the full
  discovery universe.

```text
Top 100 artifact -> measured observations -> Score -> Review -> paper freeze
  -> immutable positions snapshot -> targets -> dry-run executor -> persisted receipt
```

## Interfaces to keep

| Producer | Output and consumer |
|---|---|
| Recurring loop | `ingest-cycle.v1`; immutable artifact hash and original/effective selection. |
| `collect-measured.ts` | `input.json` binds the source artifact. Account files retain pages and snapshots; original responses are stored by SHA-256 in ignored `out/`. |
| Full account snapshots | `allStates` covers declared perp DEXes. `states` remains core + xyz for mirror; additional evidence does not expand tradable markets. |
| `measured-evidence.ts` | Pure `measureAccountEvidence()` returns `scorePatch`, `metricPatch`, positions, provenance and reasons. Unknown fields stay `null`. |
| `measured-service.ts` | Runs the planner against captured prices, positions, equity and market eligibility. Final capacity checks remain mandatory. |
| `measured-review.ts` | Rebuilds frame/evidence commitments and runs unchanged Review. Paper freeze requires a valid result and at least five sources. |

`--positions-only` first fetches the inclusive fill suffix, then reads current
positions and portfolio. It verifies old pages, deduplicates fills and preserves
original coverage gaps.
`--sample-only` appends account snapshots without touching fill history or claiming
that old fills became fresh. Use complete full-DEX snapshots for leverage samples;
legacy core/xyz-only reads do not describe the full account.

## What the measurements mean

- **Maker share:** maker perp notional divided by total perp notional over the
  covered 30-day window. Excludes spot; incomplete pagination produces no full-window value.
- **Holding time:** median duration of fully observed flat-to-flat position
  episodes. Excludes carry-in and still-open episodes. Reconstructed positions
  must agree with the terminal snapshot.
- **Time in market:** the fraction of the observed window with any reconstructed
  perp position open; requires sufficient fill and position coverage.
- **Leverage:** sampled gross perp notional / account equity, averaged only over
  the recorded observation interval. At least two valid samples spanning ten
  minutes are required. This is **not a 30-day average**. Timestamps, count and gaps
  are retained; configured leverage cannot substitute for observed leverage.
- **Historical validation:** two fixed adjacent 14-day holdouts, with training
  observations split before each evaluation interval and the repository's
  deposit-adjusted return helper. These accounts were discovered today: this is
  **retrospective validation of a current cohort**, not a point-in-time universe
  backtest. No best-window search occurs. Insufficient coverage stays unknown.
  Stability means the fraction of positive windows, not statistical confidence.
- **Execution coverage/fit:** what the existing planner can cover and size from
  one snapshot. This **does not** measure historical copying latency, slippage or profitability.

The rehearsal uses deterministic rule adapters. Actual model-provider calls need
separate receipts; having a provider adapter or workflow is not a successful call.

## Short, reproducible stability check

```bash
bun --no-env-file night-shift-integration/accelerated-ingest.ts
```

The harness runs production loop, Score, quota, HTTP and SQLite code with
synthetic upstream responses and an accelerated logical clock. It asserts partial
publication protection, audited replacement, quarantine, a separate-process restart,
zero-request duplicate replay, two ten-minute buckets, background candidate reentry,
immutable historical reads and stale-result rejection. Explicit virtual lease ticks
replace the real timer while time is accelerated.

CI runs this harness and uploads `out/accelerated-ingest/report.json` with its SHA-256.
The report binds tested source files and every check. This is a bounded
recovery rehearsal, **not a 24-hour live soak or a hosted deployment test**.
Read generated summaries for actual Review/freeze outcomes. Raw responses and
databases stay local.

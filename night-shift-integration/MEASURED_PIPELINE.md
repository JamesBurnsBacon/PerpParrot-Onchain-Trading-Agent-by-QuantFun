# Measured data handoff

Real public observations feed the existing Score and Review interfaces. The final
measured rules and both actual model committees rejected this cohort as
`INVALID_BUCKET / INSUFFICIENT_EVIDENCE`. No real-data freeze or executor run is
claimed. The separate controlled demo completes the full integration path.

## Two jobs and one unchanged boundary

- **Recurring ingest:** collect 100 accounts selected by strict Score every ten
  minutes. Record replacements and immutable results. Idle refresh rotates older
  candidates; quarantined accounts need a successful probe to return.
- **Measured rehearsal:** start with at most 25 Score finalists from a completed
  Top 100 artifact, then collect fills and account snapshots. Later ranking covers
  this measured subset, not the full discovery universe.

```text
Top 100 artifact -> measured observations -> Score -> Review
  -> INVALID_BUCKET / INSUFFICIENT_EVIDENCE (actual final result)

Only after unchanged gates pass:
Review -> paper freeze -> positions snapshot -> targets -> dry-run executor -> receipt
```

## Interfaces to keep

| Producer | Output and consumer |
|---|---|
| Recurring loop | `ingest-cycle.v1`; immutable artifact hash and original/effective selection. |
| `collect-measured.ts` | `input.json` binds the source artifact; account files retain pages/snapshots, and original responses are stored by SHA-256. |
| Full account snapshots | `allStates` covers declared perp DEXes. `states` remains core + xyz for mirror; extra evidence does not expand tradable markets. |
| `measured-evidence.ts` | `measureAccountEvidence()` returns Score/metric patches, positions, provenance and reasons. Unknown values remain `null`. |
| `measured-service.ts` | Uses captured prices, source positions and market eligibility with the production planner. Own paper capital is explicitly synthetic and unfunded; capacity checks remain mandatory. |
| `measured-review.ts` | Binds frame/evidence commitments and runs unchanged Review. Paper freeze needs a valid result and at least five sources. |

`--positions-only` fetches the inclusive fill suffix before reading current
positions/portfolio, verifies old pages, deduplicates fills and preserves coverage
gaps. `--sample-only` appends snapshots without refreshing or relabelling old fills.
Legacy core/xyz reads do not describe the full account.

## Meaning of the measurements

- **Maker share:** maker perp notional / total perp notional over the covered
  30-day window. Spot is excluded; incomplete pagination gives no full-window value.
- **Holding time:** median of fully observed flat-to-flat episodes, excluding
  carry-in and still-open episodes. Reconstruction must match the terminal snapshot.
- **Time in market:** observed time with any perp position open; sufficient fill
  and position coverage is required.
- **Leverage:** observed gross perp notional / equity, averaged over recorded
  samples. At least two valid samples spanning ten minutes are required. This is
  not a 30-day average; configured leverage is not a substitute.
- **Historical validation:** two fixed adjacent 14-day holdouts, split before each
  evaluation interval, using the repository's deposit-adjusted return helper.
  This is retrospective validation of a current cohort, not a point-in-time universe
  backtest. No best-window search occurs. Stability is the fraction of positive
  windows, not statistical confidence. Insufficient coverage remains unknown.
- **Execution coverage/fit:** current source exposures covered and sized by the
  planner; gross exposure on other DEXes lowers coverage. This is a current-position
  test, not historical copying latency, slippage or profitability.

## Final shared snapshot

[Download the measured dataset](https://github.com/JamesBurnsBacon/PerpParrot-Onchain-Trading-Agent-by-QuantFun/releases/download/night-integration-2026-10-07/measured-data-20261006T200556Z.zip)
from the [delivery release](https://github.com/JamesBurnsBacon/PerpParrot-Onchain-Trading-Agent-by-QuantFun/releases/tag/night-integration-2026-10-07).

- `measured-data-20261006T200556Z.zip`: 11,793,349 bytes, 972 files.
- SHA-256: `8030d46233569de5834146aa39e1c93c0d872fc0037fa0af38ecd652ff0e7859`.
- 25 accounts; 76 readsets (73 full all-DEX, 3 legacy incomplete); 96 retained fill
  pages; 936 raw files; 984 archived request/response bindings.
- Includes `score-inputs.jsonl`: 25 normalized inputs for the production
  `scoreCandidates()` function, reproducing the included `score-result.json`.
- The separate [immutable review input](https://github.com/JamesBurnsBacon/PerpParrot-Onchain-Trading-Agent-by-QuantFun/releases/download/night-integration-2026-10-07/measured-review-input-20261006T200556Z.json)
  has SHA-256 `b2cee57d93db11bda4f6cd9c7a171aac2e18cbc087f50f19b2c84a6347813729`.

Both deterministic rules returned an invalid bucket. Final diagnostics include
9 sub-hour holding periods, 16 unknown holding periods and **23** execution-fit
failures; reasons overlap. The prepared frame is shared unchanged between rules.

## Actual provider calls and offline verification

[Workflow 37524055099](https://github.com/JamesBurnsBacon/PerpParrot-Onchain-Trading-Agent-by-QuantFun/actions/runs/37524055099)
ran `gpt-4.1-mini-2025-04-14` and `gpt-4.1-2025-04-14`: four HTTP 200 Role/Risk
calls, zero retries. Both committees returned `INVALID_BUCKET / INSUFFICIENT_EVIDENCE`.
No Red-Team, freeze or executor followed these results.

From the matching source checkout with dependencies installed:

```bash
bun --no-env-file night-shift-integration/verify-provider.ts \
  --input /path/to/measured-review-input-20261006T200556Z.json \
  --results night-shift-integration/evidence/followup/provider \
  --out /path/to/provider-verification.json
```

No model key or network is needed. Expected marker: `PROVIDER_EVIDENCE_VERIFIED`.
The verifier binds input SHA, frame/evidence/model commitments, reconstructs
versioned Role/Risk prompts, and verifies all four audit records, exact receipt
`auditIds` and receipt/manifest commitments. `verification.json` records the result.
Five temporary-copy mutations were rejected: numeric output, audit timestamp,
removed audit ID with a recomputed receipt, changed input bytes and an injected
header field (`tamper-checks.json`). HTTP status and call count are runner metadata,
not provider-signed proof. Raw request headers are not part of the shared evidence.

## Short stability check

```bash
bun --no-env-file night-shift-integration/accelerated-ingest.ts
```

This runs production loop, Score, quota, HTTP and SQLite code with synthetic
upstream responses and an accelerated logical clock. It checks partial-publication
protection, audited replacement, quarantine, process restart, zero-request duplicate
replay, two ten-minute buckets, candidate reentry, immutable reads and stale-result
rejection. CI publishes `out/accelerated-ingest/report.json` and its hash. This is a
bounded recovery rehearsal, not a 24-hour live soak or hosted deployment test.
At code commit `4b75b59`, the final regenerated run passed 20 checks in 6.011 seconds;
all five CI jobs passed.

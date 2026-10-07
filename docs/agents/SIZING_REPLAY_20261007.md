# Copy sizing replay after #70–#75

This is an **offline research rehearsal**, not an approved roster, frozen configuration, trade, or return backtest. It reuses a saved Top 35 Score/evidence cohort and a preferred 11-person review queue (9 vaults, 2 accounts). Four of those 11 remain `REVIEW`; no source was admitted by this exercise.

## Method and result

Assumptions: $470 follower, equal AI fit for the 11 hypothetical seats, 81,818 weight units each (about 8.182% of equity per seat, about 10% cash). Actual admission uses each candidate's fit, available seat, and pace limit, so it can produce different weights. Saved market metadata supplied eligible assets (cross-margin and at least $20m open interest); 25 source positions were excluded. The Score/evidence timestamp is 2026-10-07 05:51:45 UTC; position and market reads were later, so this is **not a synchronized snapshot**.

The replay calls production `leverageScaleE6`, `computeExposures`, `capGrossExposure`, `countedGross`, and executor `planOrders`. #71 scales each source by `2 / max(30-day average leverage, 0.05)`; #70 caps a source and the aggregate at 5×; #74 counts the majority side plus half the minority side against that cap. #72's missing-average backfill had no numeric effect because all 11 saved averages were present. #75 changes the recorded review time for newly admitted seats, which this no-admission scenario does not exercise.

| $470 paper bucket | Physical target gross | Cap-counted gross | Flat-account planned orders | Planned order notional | Skips |
|---|---:|---:|---:|---:|---|
| Aggressive | $779.44 (1.658×) | $704.37 (1.499×) | 15 | $733.92 | 17 below $10 |
| Balanced ×0.5 | $389.72 | $352.18 | 10 | $323.37 | 22 below $10 |
| Conservative ×0.25 | $194.86 | $176.09 | 7 | $139.87 | 24 below $10; 1 rounds to zero |

Without leverage normalization, the same weights would target only $89.55 physical gross. Neither the per-source nor aggregate 5× cap bound in this saved scenario. Aggressive planned initial margin was $68.30, with no 95% margin scaling. Planned orders are not fills.

## Reproduction without publishing account data

Run `bun run scripts/replay-copy-sizing.ts private-input.json aggregate-output.json`. The input has `capitalUsd`, `eligibleAssets`, `sources` (address, equityE6, weightE6, averageLeverage, signed positions in notionalE6), and `markets` (the executor's market fields). Keep the input outside Git: it contains account and position data. The CLI prints only aggregate totals, order counts, skip reasons, and an input SHA-256. It never prints addresses or asset-level targets. The separate local detailed replay and input remain ignored under `work/`.

The synthetic test `packages/executor/test/replay-copy-sizing.test.ts` covers normalization, #74's partial hedge count, 5× per-source cap, asset filtering, and planner handoff. The private input and detailed asset targets are deliberately absent from this repository.

## GPT-6 Sol API closure check

One complete `strict-gate-check.ts` rehearsal was run after rebasing onto `main@2a56d9f`, using cached public reads and a local database at the same 2026-10-07 05:51:45 UTC evidence time. This was **one review run comprising three actual OpenAI API requests**, because Role, Risk, and Red-Team are separate stages. All three returned the exact requested model ID `gpt-6-sol`, passed the provider's structured-output validation, and reached the deterministic gate. Their combined reported usage was 146,122 tokens (Role 49,296; Risk 49,677; Red-Team 47,149). The API key, raw model responses, addresses, and account data are not in this note or Git; the versioned prompts remain in their existing source files.

The run scored 120 non-HFT accounts from 140 cached inputs and reviewed 25 finalists. Under this branch's **research strict policy** (40 confidence floor), 2/25 passed candidate checks. The manifest was `INVALID_BUCKET / CAPACITY`, with zero frozen sources and no trading authority. This is a successful technical fail-closed path, **not** a successful 11-source admission or evidence that the production strict gate meets its acceptance target. The separate 11-person sizing replay above is hypothetical and is not the output of this failed review. The production basic gate and live policy were not changed.

Local run command (requires a private key and ignored local caches):

```sh
bun --env-file=.env.openai run packages/backend/scripts/strict-gate-check.ts \
  --inputs work/strict-gate-20261007/inputs.json \
  --reads work/strict-gate-20261007/reads-resume.json \
  --as-of 2026-10-07T05:51:45.000Z \
  --local-dir work/strict-gate-20261007/api-validation-20261007-db \
  --model gpt-6-sol --gate strict \
  --output work/strict-gate-20261007/api-validation-20261007.json
```

Checks passed after the rebase: 64 root tests, the 38 targeted sizing/copy/planner tests, root TypeScript, and backend/executor TypeScript. The API run and its raw log stay in ignored `work/`.

For any decision, rerun on a synchronized current snapshot with real AI fit, formal committee approvals, actual roster state, current eligible markets, and execution costs. The basic gate remains the production fallback; this replay makes no policy or execution change.

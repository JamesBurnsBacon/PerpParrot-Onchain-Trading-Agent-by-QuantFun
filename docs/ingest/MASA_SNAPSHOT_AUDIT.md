# Follow-up to Masa's snapshot observations

Reference: [Masa's Oct 6 comment on PR #26](https://github.com/JamesBurnsBacon/PerpParrot-Onchain-Trading-Agent-by-QuantFun/pull/26#issuecomment-6018765189). His figures refer to the shared 10,689-row snapshot. The first pass has since finished: 20,869 addresses processed, including 10,987 regular research candidates.

## Largest matching group: shared spot exposure

We reproduced **232 groups / 1,031 rows**, with a largest group of **43 addresses**, using the same four metrics rounded to six decimal places.

Live official `spotClearinghouseState` responses show **all 43 currently have XMR1 as their only nonzero spot asset**. We additionally fetched official portfolio, perpetual state and vault-equity responses for three members:

| Address suffix | XMR1 balance | Equity in shared table | Implied price per token | Historical points shared with live official response |
| --- | ---: | ---: | ---: | ---: |
| `…ba33d` | 201.62441748 | $113,089.119520 | $560.89 | 45 |
| `…f69215` | 446.127492 | $250,228.448987 | $560.89 | 46 |
| `…35ea6e` | 200 | $112,178.00 | $560.89 | 44 |

All shared historical equity and normalized PnL points matched within one cent. These three accounts had no current perpetual positions or vault deposits. The source scanner gives each request its own address, response reader and saved evidence record; the traced original response hashes match the saved files and screening rows.

This supports shared exposure to the same spot asset as the explanation for this group, rather than a cross-address response mix-up. It does not establish that every other cluster has the same explanation or that the addresses share an owner. It also shows why a high account return alone is not evidence of independent trading skill.

After the full evidence bootstrap, all 43 are present in the exported Score inputs, but all 43 fail strict eligibility because `minTrades` remains `unknown`: the fetched records do not establish ten distinct filled orders. They are therefore absent from the strict Top 100 without adding a special XMR1 exclusion or a four-metric deduplication rule. This does not prove they have never traded.

The data release includes `anomaly-audit.json` and `anomaly-trace.jsonl.gz`: all 43 original portfolio records and current spot-state responses, plus the three full live traces. Original request fields are explicitly marked as reconstructed from the source code and saved address; the old scanner did not capture a wire-level request log. New live trace requests were recorded at fetch time. Personal provider hostnames are removed.

## Replay and controls

* Recomputed all **20,869** complete v1 rows at their saved evaluation times: **zero mismatches**, including decisions, reasons, recent-month values and actual endpoints.
* Repeated the local replay in reverse address order: identical canonical output. The release also has a streaming replay command that reverses blocks of response arrivals and checks the same invariant.
* A synthetic duplicate-series control has identical metrics and daily-return correlation **1**.
* A synthetic pair with the same four metrics (20% full/best return, 20% full/best drawdown) has daily-return correlation about **−0.0052**. Its peaks occur on different days. Four metric matches cannot safely replace time-series clone detection.

Run from `packages/backend`, after downloading the [data release](SCORE_DATA.md):

```bash
bun --no-env-file src/ingest/loop/replay-research.ts data/score-handoff-2026-10-06
bun test test/ingest-research-controls.test.ts
```

The archived v1 arithmetic is used only for offline replay. It is not a new screening policy and is not called by the Top 100 worker. Matching groups receive investigation metadata; their v1 decisions are unchanged. Formal clone grouping remains in the team's existing Score.

## Changes adopted in the current pipeline

The worker already publishes only complete batches and preserves the previous complete result after failure. Its new official-API attempts also record run, address, slot, request conditions, attempt number, status, fetch times, response hash and budget weight. Retries have distinct attempt IDs under one operation ID. Published artifacts pin cohort, target-list hash, Score source/config hashes, cutoff and input evidence IDs. No research data is written into `cre_snapshots`, `dashboard_artifacts` or `review_audit`.

The user's current requirement is strict Score Top 100 acquisition every ten minutes. That cadence is an explicit experiment choice; it is not inferred from Mirror's separate ten-minute cadence. Masa's proposed fixed Warm 500 / Hot 100 v1 experiment and offline hysteresis comparison remain a separate proposal. No new 500-account schedule or two-observation gate has been silently enabled.

The completed full-cohort Top 100 ran through two consecutive official-API cycles and native CRE simulation. The next-cycle selection and all 200 request-to-response associations were checked. [Measured results](LIVE_PIPELINE_VALIDATION.md) distinguish these runs from the separate crash/recovery probe. This validates the collection pipeline, not a week of detection-quality evaluation.

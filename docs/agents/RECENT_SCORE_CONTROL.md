# Recent-performance control group

This is a local research comparison, not a change to the production pick, model
prompts, review policy, or execution path. It tests whether the qualified list's
current Score Top40 under-represents accounts with strong recent returns.

Run:

```sh
bun scripts/research/recent-performance-control.ts --inputs work/qualified-250.json --output work/recent-control
```

The address-bearing input and selected group remain under gitignored `work/`;
only aggregate results belong in Git. The same point-in-time ~250 qualified
accounts are screened for >100 orders per day. All groups have 40 distinct
finalists and the same trader/vault mix.

| Group | Selection rule | Purpose |
| --- | --- | --- |
| A: current Score | Existing 90-day Score ranking | Production baseline |
| B: 30-day Score | Same Score terms and filters, 30-day lookback | Check whether simply shortening Score's window increases recent returns |
| C: recent return | Existing Score eligibility and clone grouping; rank eligible representatives by the deposit-adjusted return over the latest 30 days | Deliberately increase recent-return representation; let the unchanged committee test the resulting risk |

The ranking for C does not imply safety or copyability. For each group, compare
the median and mean 30-day return, overlap with A, Role/Risk/Red-Team decisions,
hold-gate pass count, valid compiled sources, and failure reasons. Use identical
provider, prompt version, policy and review evidence where available. A local
rehearsal using cached public responses is not a synchronized backtest; current
position reads can occur after the saved Score snapshot. Future seven- and
30-day returns must be recorded after the selection timestamp before claiming
that C predicts better live outcomes. Do not tune the model or a return cutoff
to force a target number of sources.

On the saved 2026-10-07 qualified-250 snapshot, 40 accounts exceed the
100-orders/day high-frequency exclusion, leaving 210. The same 39-trader,
one-vault composition is used in all groups. A and C overlap on 15 addresses.

| Group | Median latest-30-day return | Return ≥10% | Committee result |
| --- | ---: | ---: | --- |
| A: current Score | 20.86% | 30/40 | 4 hold-passing bench accounts; compiler invalid |
| B: 30-day Score | 15.87% | 24/40 | Not run through committee |
| C: recent return | 45.93% | 40/40 | 9 pass individual checks; 7 hold-passing bench accounts; compiler valid with 7 sources |

These are in-sample descriptions of the saved snapshot, not forward returns.
The A and C reviews used GPT-6 Sol, prompt v1.2.0 and the same basic fallback
policy. All six calls across the two runs returned HTTP 200 with valid output.
The C run shows a larger reviewable bench, but it still misses the desired eight
sources. Some public fill/position reads were collected after the saved Score
snapshot, and the two groups were not observed simultaneously. This is a
mixed-time local rehearsal, not evidence of an out-of-sample return advantage.
Neither run is a deployed selection.

The script implements only the group construction and aggregate comparison. It
does not alter `/cron/pipeline/select`; promoting C would require a separate
reviewable selection change and fresh forward evidence.

# Churn: what we changed, and how to measure it

This is the dated record of the 2026-10-07 churn work; “today” and replay counts below refer to that capture, not a continuously updated deployment measurement. It started as a handoff (`churn_limit.md`) listing seven ways the copy loop overtraded. Each was fixed, designed into the roster ([ROSTER.md](ROSTER.md)), or deliberately not taken. Terminology: we trade **perps**, never "coins".

## The issues and what happened to them

| # | Issue | Outcome |
|---|---|---|
| 1 | One wallet going flat rescaled every other perp ("flat is not a signal") | **Fixed (#65).** A wallet's exit is followed at its own weight, and its weight isn't spread over the others. This also ended the runs failing with "active-source concentration exceeds ceiling". |
| 2 | Full closes skipped the drift band, so a wallet leaving a perp for one snapshot cost a round trip | **Fixed (#63).** A close waits for its target to be 0 for **3 runs** (`pendingCloses`). Untradable markets and a human flatten still close at once. |
| 3 | No stickiness: the wallet list was swapped wholesale on every re-review | **Built: the roster (#66–#69, #75, #76).** Each wallet holds a seat at a fixed weight with a paced minimum tenure (12–72 h). Exits release seats, warning signs wind wallets down (follow exits, ignore new entries), and only a 50% trading loss removes one. Admissions are at most 2 an hour and 8 a day. Seats are sized for 12–15 wallets. |
| 4 | Weight-only changes were dropped | **Fixed (#64).** A weight that moves by more than 5 points refreshes. |
| 5 | The deciding gate ignored hold time | **Built (#67).** Admission needs copyable share ≥ 50% at a 90-minute horizon, or book turnover ≤ 1/day for wallets with nothing closed. |
| 6 | No turnover budget | **Not taken.** The roster's implied turnover is monitored only. |
| 7 | The 10% band was weak for small targets | **Fixed (#63).** A leg also needs a gap ≥ 0.5% of equity; for a bucket, that's 0.5% of equity × its multiplier (#70). |

## Other decisions the work settled

- **Leverage** (#70, #71, #74):
  - the gross cap is 5×, with the minority side of offsetting longs and shorts counted at half;
  - each wallet is normalized to 2× of its own 30-day average leverage (floor 0.05×), and no single wallet counts past 5× on its own.
- **Buckets** (#70): Aggressive × 1, Balanced × 0.5, Conservative × 0.25 of the same targets, and nothing else differs.
- **Positions** (#76): at most 15 perps. The 15 largest are kept and scaled so the counted gross is unchanged.
- **Safety** (#62): a bot never pauses or flattens. Lost exchange answers are reconciled automatically.

## Measuring it

- **Live:** `/pipeline` → `roster.impliedTurnover`, and the dashboard's roster panel (seats, tenure, activity, changes).
- **Paper:** `/paper` → each book's `turnoverPerDay` (traded notional per day ÷ starting capital), on the dashboard next to fees and trades (#77). The dry-run executor can't measure churn, because its account never fills.
- **Replay:** `bun run scripts/replay-churn.ts [--hours 24] [--equity 10000]` (in `packages/backend`).
  - It fetches stored snapshots from the public backend and replays them through today's target maths and leg rule against a simulated account, under today's rules and the rules from before this work.
  - Prices are held constant, so it measures what the rules trade, not PnL.
  - Trades in the run where the wallet set, weights or leverage scales changed, and in its two confirmation runs, count as **switches**. The rest is **steady** churn.

### Replay on 2026-10-07 (at $10k)

| Window | Rules | Orders | Traded | Switches | Steady turnover/day | Closes | Reopened < 1 h |
|---|---|---|---|---|---|---|---|
| last 8 h | today | 89 | $55,070 | 5 ($46,168) | 2.67× | 21 | 6 |
| last 8 h | before | 128 | $56,291 | 5 ($47,320) | 2.69× | 37 | 19 |
| last 2 h | today | 26 | $23,845 | 2 ($23,274) | 0.68× | 0 | 0 |
| last 2 h | before | 48 | $24,408 | 2 ($23,598) | 0.97× | 10 | 5 |

- **Order count:** today's rules cut orders by 30–45%.
- **Round trips:** they cut closes followed by a reopen within the hour by about 70%.
- **What still dominates:** traded dollars. This morning's wholesale wallet swaps, and the jump to normalized leverage at 08:29, are one-off switches.
- **What the roster is for:** it makes future switches seat-by-seat. Its effect will show in the replay as windows after 07:56 UTC accumulate.

## Still open

- **Taking Balanced or Conservative live.** Each needs its own Hyperliquid sub-account, agent wallet and executor configuration, with its multiplier applied to targets and bands, as the paper books do.
- **Roster size as an explicit AI output.** Today it is the AI's approvals, sized for 12–15.

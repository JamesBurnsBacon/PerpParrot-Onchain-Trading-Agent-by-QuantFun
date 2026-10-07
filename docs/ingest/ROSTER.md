# Per-wallet roster: tenure, exits and hold time

**Status:** decisions settled by the owner on 2026-10-07 (§10); being built in that order. This document is the reference.
**Context:** `churn_limit.md` issues #3 (stickiness) and #5 (hold time), and the owner's answers on churn.
**Already shipped on `main`:**
- #63: closes wait for 3 runs at 0; drift band floor at 0.5% of equity.
- #64: weights refresh when one moves by more than 5 points.
- #65: a wallet's exit is followed and its weight is no longer spread over the others.

## 1. What the owner asked for

| Topic | Owner's words, condensed | What this design does |
|---|---|---|
| Wallet goes flat | An exit (take profit or loss) is a signal: reduce our exposure. But don't sit in cash because of it: that's the cleanest time to replace the wallet. | Exits are followed (#65). An exit **releases the wallet's seat** and a replacement is admitted (§4.3). |
| Stickiness | Per wallet: every new wallet entry is included for a set amount of time. Needs substantial design. | A **roster of seats**. Each admitted wallet has a **minimum tenure**, and the list changes one seat at a time (§3, §4). |
| Hold time | Needs deeper consideration. | Measured as **copyable share** and **book turnover** rather than a median hold. Used for admission and tenure length; churn is monitored (§5). |
| Risk | Withdrawals are not trades. Only a 50% trading loss removes a wallet; "I don't want the portfolio to panic sell". | One immediate removal: a 50% loss on PnL since admission. Every other warning sign winds the wallet down (§4.5). |

## 2. Evidence from the live system (2026-10-07)

**The wallet list is swapped wholesale.** Three selections in 1 h 40 min (03:54, 04:34, 05:34 UTC) each activated a different wallet set. Every swap re-targets the whole book:
- the executor went from 31 to 20 to 33 to 20 targeted perps across configurations;
- gross exposure went 0.20 → 0.79 → 0.11 of equity.

**The current picks churn fast relative to what they hold.** These are the 25 picks of selection 3, from 30 days of Hyperliquid fills:

| Active wallet (seat) | Kind | Gross ÷ equity | Traded ÷ equity per day | Book turnover (traded ÷ gross per day) | Median hold, by count | Median hold, by notional | Notional in holds < 60 min |
|---|---|---|---|---|---|---|---|
| 0xb65d… | vault | 0.06 | 0.15 | 2.5× | 66 min | 266 min | 32% |
| 0xa415… | vault | 0.14 | 0.46 | 3.3× | 45 min | 139 min | 38% |
| 0xa1b6… | vault | 0.17 | 0.37 | 2.2× | 79 min | 391 min | 17% |
| 0x73f6… | vault | 0.00 (flat now) | 0.35 | — | 24 min | 32 min | 61% |
| 0x4b0e… | vault | 0.00 (flat now) | 0.63 | — | 10 min | 11 min | 75% |
| 0xe65b… | vault | 0.22 | 0.04 | 0.2× | no closed position in 30 days | — | — |

- All six active wallets are HyperCore vaults with low leverage that turn over their small books **2–3 times a day**.
- At their frozen weights, they imply copy turnover of about **0.30× our equity per day** (before our bands), against gross exposure of about 0.11×. In other words, we would re-trade our whole book roughly 2.7 times a day.
- The **long-hold picks were not chosen.** Among the 25 were traders and vaults with median holds of 17–168 hours, most with book turnover of 0.02–0.3 a day; the basic gate preferred the low-leverage vaults.
- **Count medians mislead.** A wallet's count-median hold is often several times shorter than its notional-weighted median: many small scalps hide a few large, long positions.
- **Vaults that never close a position have no hold time at all**, yet still turn over their book. 0xe65b… adjusted sizes for 30 days without a single full close.

**Dry-run runs can't measure churn.** The dry-run account never fills, so every run re-plans the same opening orders from flat. Churn has to be measured on the paper books (which hold positions) or by replaying stored snapshots (§8).

## 3. The model: a roster of seats

The active configuration becomes a **roster**: a set of seats, each holding one wallet.

- **Size: at least 5 wallets, aiming for 12–15** (owner, 2026-10-07; the separate 5–15 limit is on *positions*, the perps we hold, see README §4.4). The target `N` is the number of wallets the latest AI reviews approve (the bench plus seated wallets still approved), clamped to **12–15**: with fewer approved wallets, seats stay sized for 12 and the rest is cash. Minimum 5 is the freeze's floor.
- **Fixed seat weight.** Each seat's weight is set **when its wallet is admitted** and doesn't change when other seats change:
  - `weight = s × fit modifier`;
  - `s = (1 − cashBuffer) / N`, with `N` as it stands **at admission** (0.9 ÷ 10 = 9%); existing seats keep their weights when `N` changes;
  - fit modifier = the wallet's AI fit ÷ the mean fit of approved wallets, clamped to [0.5, 1.5], capped at `maxSourceWeight`;
  - a new seat never takes the total past `1 − cashBuffer`: it is shrunk to the room left, or waits if under half a seat;
  - refreshed only by a re-review, and only when the weight moves by more than 5 points (#64's rule).
- **Why fixed weights:** renormalizing all weights on each admission would rescale every perp (the same churn #65 removed for exits). With fixed seats, admitting or releasing one wallet touches **only that wallet's perps**.
- **Empty seats hold cash** until they're filled. Seats are filled fast (§4.1), so this cash is short-lived.
- **The executor contract is unchanged.** Each roster change freezes a new `FrozenConfiguration` (hash) that the executor checks, as today. The new configuration differs from the previous one only in the seats that changed.

```
           admit (approved, seat open)
 bench ───────────────────────────────▶ PROBATION ──(tenure ends)──▶ SEATED
   ▲                                       │  │                        │  │
   │                                       │  └─ idle (flat 6 h) ─────┐ │  └─ exit (flat 3 runs) ─┐
   │                                       │     (§4.3)               │ │                         │
   │                                       └─ 50% trading loss ─▶ REMOVED └─ warning sign ──▶ WINDING DOWN ──(flat / 48 h)─┐
   │                                          (normal 3-run closes)   │      (follow exits only)                   │
   └────────────── cooldown ◀──────────── RELEASED ◀──────────────────┴────────────────────────────────────────────┘
```

## 4. Seat lifecycle

### 4.1 Admission: filling an open seat
- **The bench.** The top approved candidates are kept as a ranked bench: Score's 40, reviewed by the AI, filtered by the copyability gates of §5. It holds every wallet a review of the picks approved in the last 12 h, as of that wallet's latest review (a later review that didn't approve it takes it off).
- **Filling a seat.** When a seat is open, the highest-fit bench candidate whose approval is fresh (reviewed within 12 h) is admitted at the next 10-minute select. A fresh approval needs no new AI call.
- **Rate limit:** at most **2 admissions per hour** and **8 per day**. The cap keeps the roster from turning over in a burst, as it did this morning. Below 5 seats the limit doesn't apply, so the roster can always be frozen.
- **Cooldown:** a released wallet can't be re-admitted for 24 h, so a wallet can't ping-pong in and out.
- **Late entry:** a wallet admitted while holding positions is copied at once, whole book (owner: copy everything).
- **First run:** the roster is seeded from the active configuration's wallets, as seated.

### 4.2 Minimum tenure (probation)
- **Tenure:** each admitted wallet keeps its seat for at least **T_min**. During probation it can't be displaced for ranking reasons: a better-ranked candidate waits for a seat to open.
- **T_min comes from the wallet's own pace**, so a fast trader isn't held for days and a slow one isn't judged in hours: `T_min = clamp(3 / book turnover per day, 12 h, 72 h)`.
  - Turnover 6×/day → 12 h (the floor).
  - Turnover 2.5×/day → 29 h.
  - Turnover 0.2×/day → 15 days → capped at 72 h.
- **Risk breaches override tenure** (§4.5).

### 4.3 Exit releases the seat (the owner's "cleanest time to replace")
- **After tenure:** a wallet **flat for 3 runs in a row** (the same confirmation as our closes, #63) releases its seat, and the next select admits a replacement.
- **During probation:** the seat is kept while the wallet is briefly flat, but released once it has been **flat for 6 h** (idle).
- **Why it's clean:** by then we have already followed its exit, so releasing the seat forces no trade of ours. The replacement's opening trades deploy the cash the exit freed.

### 4.4 Losing approval after tenure: wind down, don't dump
A seated wallet is wound down when:
- **past tenure**, it loses approval: a re-review no longer approves it, or it is missing from the qualified list at 2 consecutive 12-hourly re-reviews; or
- **at any time**, a warning sign appears (§4.5): the Risk model rejects it, it turns high-frequency, or it is liquidated.

It then goes into **winding down**:
- we keep following its **reductions and closes**, but ignore its **new entries and increases**;
- once it is flat (§4.3), the seat is released.

Winding down never forces us to sell a position the wallet still holds, which is where most rotation churn comes from. **Cap:** 48 h. After that the seat is released and its remaining slice closes through the normal 3-run confirmation.

**How it's enforced:** when winding down starts, the wallet's leverage per perp (notional ÷ equity) is recorded as a cap. Each select ratchets the cap down to what the wallet still holds (same sign, never up). A perp that flips or closes drops out. Each snapshot carries the caps (`windDown`), and `targetsFromSnapshot` limits the wallet's slice to them, so the executor and the paper books apply them alike. Once no cap is left, the seat is released.

### 4.5 Risk: one removal, everything else winds down
The owner trusts the sorting and doesn't want the portfolio to panic sell. **Withdrawals are not trades and never count.**
- **Immediate removal, overriding tenure:** a **trading loss of 50%**. That is Hyperliquid's PnL since admission (all-time PnL now minus at admission) ÷ the wallet's equity at admission, checked every 10 minutes. The removed wallet's slice closes through the normal 3-run confirmation: no special fast path.
- **Wind down (§4.4), at any time:**
  - the Risk model rejects it at a 12-hourly re-review;
  - it turns high-frequency (more than 100 orders a day);
  - it is liquidated.

### 4.6 Fresh start (operator)
Replaces every seat at once, e.g. after the roster was seeded from an early, small sample (owner, 2026-10-07). In the Supabase SQL editor:

```sql
update pipeline_controls set fresh_start_requested_at = now() where id = 1;
```

- The next select step reviews the current 40 once more, even if they haven't changed, so the bench gains approvals.
- The old seats stay and **nobody is admitted** until at least **5** approved wallets are on the bench (fresh, passing the hold gate, not cooling down). Only approvals from reviews of the **current qualified list** count (reviews after its latest `qualified_at`), so wallets approved from an earlier, smaller list aren't seated.
- Then every seat admitted before the request is **released** (`release_reason = 'fresh start'`, no 24 h cooldown, so an approved old wallet can come straight back). The bench fills 5 seats at once; the rest follow at the usual pace (§4.1). The new roster is frozen and activated.
- Once it stands, the **paper books restart** from their starting capital: `paper_state` and `paper_points` move to `paper_state_archive` and `paper_points_archive` (with `archived_at`). Nothing is deleted.
- `pipeline_controls.fresh_start_done_at` records it. A new request (a later `fresh_start_requested_at`) starts another.

The live equity chart needs no reset: `/api/executor/equity` plots live runs only, so it starts at go-live.

## 5. Hold time, reconsidered

### 5.1 What we use today
- `medianHoldMinutes`: the median of fully closed positions over 30 days, **by count** (`pipeline/evidence.ts`).
- `executionFit`: allows only for our ≤ 10-minute **entry** lag.
- The **strict gate** drops holds under 60 min and discounts those under 3 h and 6 h. The **basic gate**, which is the one deciding today, ignores hold time.

### 5.2 Why that's not enough
1. **Exit lag is now longer than entry lag.**
   - Entries follow within 0–10 minutes.
   - Closes now wait for 3 runs (#63), so we exit **20–30 minutes** after the wallet.
   - Against a 60-minute hold, that is a third of the trade spent holding a position the wallet no longer has.
2. **A count median underweights the trades that matter.** Many small scalps hide a few large, long positions, and the reverse also happens. What we copy is notional, not trade count.
3. **Wallets that never close a position have no episode hold**, yet can turn over their book several times a day (§2). For our churn, what matters is how fast the book changes.

### 5.3 Proposal: two measures, three uses

| Measure | Definition | Why |
|---|---|---|
| **Copyable share** | Share of the wallet's peak notional in positions held **≥ 90 minutes** (owner's horizon), over 30 days of fills. | It weights what we would actually copy. Our entry lag is up to 10 minutes and our exit lag 20–30 minutes. |
| **Book turnover** τ | Traded notional per day ÷ average gross notional. | How fast the wallet's book changes, defined even for wallets that never fully close. Our turnover from a seat ≈ `weight × traded notional per day ÷ equity`. |

**Uses:**
1. **Bench gate:** copyable share ≥ 50%, *or* τ ≤ 1 per day for wallets with no closed positions.
2. **Tenure length:** `T_min` from τ (§4.2). A wallet with unknown τ gets 24 h.
3. **Churn, monitored only:** the roster's implied turnover, Σ over seats of `weight × traded per day ÷ equity`, is shown on `/pipeline` and never blocks an admission (owner). Today's roster would be at 0.30× equity a day.

### 5.4 The current picks against it
From the table in §2, at the 90-minute horizon (copyable share = 1 − share of notional in shorter holds):
- **Fail the 50% copyable-share gate:** 0x73f6… (38%) and 0x4b0e… (7%), the two fastest active vaults.
- **Pass:** 0xa1b6… (78%), 0xb65d… (63%), 0xa415… (56%), and 0xe65b… (no closed positions; book turnover 0.2 a day ≤ 1). So do most of the long-hold traders and vaults further down Score's 25.

That is the intended shift: toward wallets whose trades we can follow from a 10-minute loop.

## 6. Data model

| Table | Purpose |
|---|---|
| `roster_seats` (new) | One row per seat occupancy. Columns:<br>• `address`, `weight_units`, `admitted_at`, `min_tenure_until`<br>• `state`: `probation` / `seated` / `winding_down` / `released` / `removed`<br>• flat tracking: `flat_since`, `flat_runs`, `last_run_at`<br>• PnL baseline: `equity_at_admission`, `pnl_at_admission`<br>• wind-down: `wind_down_until`, `caps`<br>• `released_at`, `release_reason`, `admitted_by` (selection run), `reviewed_at`, `unqualified_reviews` |
| `roster_events` (new) | Append-only: admit, release (exit), wind-down start, removal (with which breach), weight refresh. Gives a per-wallet history and churn accounting. |
| `selection_runs` | Gains the **bench**: approved candidates with fit, the §5 measures and approval time. |
| `configurations` | Unchanged. One frozen configuration per roster version; the executor still checks the hash. |
| `run_targets` (#60) | Unchanged. Used to measure churn per perp. |

## 7. The 10-minute select, with a roster
1. **Observe:** from the latest stored snapshot, update each seat's flat tracking and ratchet wind-down caps.
2. **Loss check:** PnL since admission for every seat → `removed` at a 50% loss.
3. **Lifecycle:**
   - probation past `min_tenure_until` → `seated`;
   - probation flat for 6 h → `released`;
   - seated flat for 3 runs → `released`;
   - winding down with no cap left, flat, or past 48 h → `released`.
4. **Review:** review the bench when Score's 40 change, and every seat every 12 h (warning signs, approval, weight refresh).
5. **Fill:** open seats from the fresh bench, within the pace limits.
6. **Freeze and activate:** if any seat or weight changed and at least 5 seats are active.

## 8. Measuring churn, before and after
- **Paper books:** they already hold positions. Add turnover, fees, round trips and closes followed by reopens to the paper view.
- **Replay:** `run_snapshots` stores every run's exact positions. Replay the target maths and the planner against a simulated account, with and without the roster rules, using the same code the executor uses (`shared/copy.ts`, `shared/rebalance.ts`).
- **Report:**
  - turnover per day;
  - fees;
  - seat changes per day and median tenure;
  - idle-cash share (empty seats plus flat wallets);
  - tracking error against unconstrained targets.
- **Acceptance:** turnover at least halved against today's rules, idle-cash share under 20% on average, no rise in drawdown in replay.

## 9. Rollout (each step a PR, merged when green)
The owner chose **on as soon as built**: we're in dry run, so there is no flag gate and no replay prerequisite. Churn is measured on the paper books as it runs.

| Phase | Change |
|---|---|
| 0 | #63, #64 and #65 (done) |
| 1 | §5 measures, roster tables, seat lifecycle (§4.1–4.3), pace limits, the 50% loss removal, roster status on `/pipeline` |
| 2 | Winding down with caps (§4.4), warning signs (§4.5), 12-hourly re-review |
| 3 | Dashboard roster panel (#69); paper turnover (#77); churn replay `scripts/replay-churn.ts` and the record in [CHURN.md](CHURN.md) |

## 10. Decisions (owner, 2026-10-07)

| # | Question | Decision |
|---|---|---|
| D1 | Minimum tenure | `clamp(3 ÷ book turnover per day, 12 h, 72 h)` |
| D2 | A wallet that exits during probation | Keep the seat; release it if the wallet stays flat for 6 h |
| D3 | Seat weights | Fixed seat size × fit modifier (0.5–1.5), set at admission |
| — | Seat size when the AI's count changes | Sized at admission (0.9 ÷ current target); existing seats keep their weights |
| D4 | Losing approval while holding positions | Wind down: follow exits, ignore new entries; at most 48 h |
| D5 | Hold time | Copyable share and book turnover |
| — | Copyable horizon | 90 minutes |
| D6 | Pace of change | ≤ 2 admissions an hour and 8 a day; 24 h cooldown |
| D7 | Late entry | Copy everything |
| D8 | Roster size | At least 5 wallets, sized for 12–15 (the AI's approvals above 12 raise it); positions (perps held) at most 15 — clarified 2026-10-07 |
| — | Churn budget | Monitor only |
| — | Risk | Only a 50% trading loss (PnL since admission) removes; withdrawals never count; the other signs wind down |
| — | Re-review | Every 12 h |
| — | Rollout | On as soon as built |

# Per-wallet roster: tenure, exits and hold time

**Status:** design proposal for the owner's review (2026-10-07). Nothing here is built yet.
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
| Hold time | Needs deeper consideration. | Measured as **copyable share** and **book turnover** rather than a median hold. Used for admission, tenure length and a churn budget (§5). |

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

- **Size:** target **N = 10** seats, minimum 5 (the freeze's floor), maximum 15 (the owner's range).
- **Fixed seat weight.** Each seat's weight is set **when its wallet is admitted** and doesn't change when other seats change:
  - `weight = s × fit modifier`;
  - `s = (1 − cashBuffer) / N` (0.9 / 10 = 9%);
  - fit modifier in [0.5, 1.5], from the AI's bucket fit at admission, capped at `maxSourceWeight`;
  - refreshed only by a re-review, and only when the weight moves by more than 5 points (#64's rule).
- **Why fixed weights:** renormalizing all weights on each admission would rescale every perp (the same churn #65 removed for exits). With fixed seats, admitting or releasing one wallet touches **only that wallet's perps**.
- **Empty seats hold cash** until they're filled. Seats are filled fast (§4.1), so this cash is short-lived.
- **The executor contract is unchanged.** Each roster change freezes a new `FrozenConfiguration` (hash) that the executor checks, as today. The new configuration differs from the previous one only in the seats that changed.

```
           admit (approved, seat open)
 bench ───────────────────────────────▶ PROBATION ──(tenure ends)──▶ SEATED
   ▲                                       │  │                        │  │
   │                                       │  └─ exit (flat 3 runs) ──┐ │  └─ exit (flat 3 runs) ─┐
   │                                       │     (§4.3)               │ │                         │
   │                                       └─ risk breach ──▶ REMOVED │ └─ loses approval ──▶ WINDING DOWN ──(flat)──┐
   │                                          (unwind now)            │      (follow exits only)                   │
   └────────────── cooldown ◀──────────── RELEASED ◀──────────────────┴────────────────────────────────────────────┘
```

## 4. Seat lifecycle

### 4.1 Admission: filling an open seat
- **The bench.** The top approved candidates are kept as a ranked bench: Score's 25, reviewed by the AI, filtered by the copyability gates of §5.
- **Filling a seat.** When a seat is open, the highest-fit bench candidate whose approval is fresh (reviewed within 12 h) is admitted at the next 10-minute select. A fresh approval needs no new AI call.
- **Rate limit:** at most **2 admissions per hour** and **8 per day**. The cap keeps the roster from turning over in a burst, as it did this morning.
- **Cooldown:** a released wallet can't be re-admitted for 24 h, so a wallet can't ping-pong in and out.
- **Late entry** (open question D7). A wallet admitted while holding positions is copied immediately, so we enter its trades late. The alternative is to prefer bench candidates that are flat or whose positions are young, and to copy only what they do after admission.

### 4.2 Minimum tenure (probation)
- **Tenure:** each admitted wallet keeps its seat for at least **T_min**. During probation it can't be displaced for ranking reasons: a better-ranked candidate waits for a seat to open.
- **T_min comes from the wallet's own pace**, so a fast trader isn't held for days and a slow one isn't judged in hours: `T_min = clamp(3 / book turnover per day, 12 h, 72 h)`.
  - Turnover 6×/day → 12 h (the floor).
  - Turnover 2.5×/day → 29 h.
  - Turnover 0.2×/day → 15 days → capped at 72 h.
- **Risk breaches override tenure** (§4.5).

### 4.3 Exit releases the seat (the owner's "cleanest time to replace")
- **When:** a wallet that held positions while seated is **flat for 3 runs in a row**, the same confirmation as our closes (#63).
- **Then:** its seat is **released** and the next select admits a replacement.
- **Why it's clean:** by then we have already followed its exit, so releasing the seat forces no trade of ours. The replacement's opening trades deploy the cash the exit freed.
- **An exit during probation** is open question D2. Recommended: release too. A wallet that exits within its tenure has finished its trade, and holding its seat in cash contradicts "don't sit in cash because of it". Tenure protects a wallet **while it is trading**, not while it is idle.

### 4.4 Losing approval after tenure: wind down, don't dump
A seated wallet past tenure loses approval when:
- a re-review rejects it or drops it below the bench; or
- it falls out of the qualified list at 2 consecutive scans.

It then goes into **winding down**:
- we keep following its **reductions and closes**, but ignore its **new entries and increases**;
- once it is flat (§4.3), the seat is released.

Winding down never forces us to sell a position the wallet still holds, which is where most rotation churn comes from. **Cap:** 48 h. After that the seat is released and its remaining slice closes through the normal 3-run confirmation. (Open question D4.)

### 4.5 Risk removals: immediate, override tenure
Each of these is checked every 10 minutes on the snapshot we already read, plus each re-review:
- the Risk model rejects the wallet;
- drawdown since admission beyond a threshold (e.g. 25%);
- gross leverage above the policy's cap;
- a liquidation;
- equity falls by more than 50% (a withdrawal);
- it becomes a high-frequency trader (more than 100 orders a day);
- a clone or link to another seat is found.

A removed wallet's slice is unwound **at once**, without waiting for the 3-run close confirmation.

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
| **Copyable share** | Share of the wallet's peak notional in positions held **≥ 3 h**, over 30 days of fills. | 3 h keeps our ~30-minute exit lag under ~15% of the hold. It weights what we would actually copy. |
| **Book turnover** τ | Traded notional per day ÷ average gross notional. | How fast the wallet's book changes, defined even for wallets that never fully close. Our turnover from a seat ≈ `weight × traded notional per day ÷ equity`. |

**Uses:**
1. **Bench gate:** copyable share ≥ 50%, *or* τ ≤ 1 per day for wallets with no closed positions. Fixed in the basic gate and the strict gate alike.
2. **Tenure length:** `T_min` from τ (§4.2).
3. **Churn budget for the roster:** Σ over seats of `weight × traded per day ÷ equity` ≤ **0.15× equity per day**. Admission skips a candidate that would break the budget.
   - Today's roster would be at 0.30.
   - Fees are about 4.5 bps taker plus slippage, so 0.15×/day costs roughly 0.1% of equity a week.

All three thresholds are **starting points to be checked by replay** (§8) before they're switched on.

### 5.4 The current picks against it
From the table in §2:
- **Fail the 50% copyable-share gate:** three of the five active wallets that have closed positions (0xa415… at 46%, 0x73f6… at 30%, 0x4b0e… at 4%).
- **Near or above it:** 0xb65d… (55%) is near the threshold; 0xa1b6… (70%) passes.
- **Pass easily:** most of the long-hold traders and vaults further down Score's 25.

That is the intended shift: toward wallets whose trades we can follow from a 10-minute loop.

## 6. Data model

| Table | Purpose |
|---|---|
| `roster_seats` (new) | One row per seat occupancy. Columns:<br>• `address`, `seat`, `weight_units`, `admitted_at`, `min_tenure_until`<br>• `state`: `probation` / `seated` / `winding_down` / `released` / `removed`<br>• `released_at`, `release_reason`<br>• `admitted_by` (selection run), `approval_at` |
| `roster_events` (new) | Append-only: admit, release (exit), wind-down start, removal (with which breach), weight refresh. Gives a per-wallet history and churn accounting. |
| `selection_runs` | Gains the **bench**: approved candidates with fit, the §5 measures and approval time. |
| `configurations` | Unchanged. One frozen configuration per roster version; the executor still checks the hash. |
| `run_targets` (#60) | Unchanged. Used to measure churn per perp. |

## 7. The 10-minute select, with a roster
1. **Exits:** seats whose wallet has been flat for 3 runs → `released`, or flat-out of winding down.
2. **Risk checks** on every seat, from the latest snapshot → `removed`.
3. **Tenure:** probation seats past `min_tenure_until` → `seated`.
4. **Fill:** open seats, within the rate limit and churn budget, from the fresh bench → `probation`.
5. **Review:** re-review the bench when Score's 25 change, and every seat every 12 h (with the scans) for §4.4 and §4.5.
6. **Freeze and activate:** if any seat changed, freeze and activate a new configuration.

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

| Phase | Change | Switch |
|---|---|---|
| 0 | #63, #64 and #65 (done) | — |
| 1 | Measurement: paper turnover and fees in `/paper`, and a replay script over `run_snapshots` | — |
| 2 | §5 measures in `evidence.ts` (copyable share, book turnover), recorded on the bench, not yet gating | — |
| 3 | Roster tables, seat lifecycle (§4.1–4.3), rate limit, cooldown | `ROSTER=on` (the current wholesale path stays the default until replay passes) |
| 4 | Winding down (§4.4) and risk removals (§4.5) | `ROSTER=on` |
| 5 | §5 gates and churn budget switched on after replay sets the thresholds | `ROSTER_GATES=on` |

## 10. Decisions for the owner

| # | Question | Recommendation |
|---|---|---|
| D1 | Minimum tenure | `clamp(3 ÷ book turnover per day, 12 h, 72 h)`, so it follows the wallet's pace |
| D2 | A wallet that exits during probation | Release the seat (tenure protects trading, not idle cash) |
| D3 | Seat weights | Fixed seat size × fit modifier (0.5–1.5) set at admission; empty seats are cash |
| D4 | A wallet that loses approval while holding positions | Wind down: follow its exits, ignore its new entries, release when flat; at most 48 h |
| D5 | Hold time | Copyable share (≥ 3 h holds) and book turnover instead of a median hold; thresholds set by replay |
| D6 | Pace of change | ≤ 2 admissions an hour and 8 a day; 24 h cooldown before re-admitting a released wallet |
| D7 | Late entry | Copy existing positions at admission (simple), and prefer bench candidates that are flat or have young positions |
| D8 | Roster size and churn budget | N = 10 seats; churn budget 0.15× equity per day |

# Research screening v1: calculations, selection rules, and unusual returns

This explains the first-pass research shortlist shared with the team on **6 October 2026**. It is a broad search for accounts worth investigating. A `candidate` is **not** a verified trader, a formal Score finalist, or an approved copy-trading target.

The shared snapshot contains **10,689 regular candidates**, with **19,452 of 20,869 source addresses processed** at **2026-10-06 13:56:15 UTC**. These are frozen snapshot counts, not a claim that the scan was complete. The [shared HTML table](https://perpparrot-research-candidates.bradleylyu.chatgpt.site) includes only `candidate` rows; accounts requiring extra risk review are excluded.

This document records the locally executed `research-screen.v1` implementation. Its [source snapshot](examples/research-screen-v1.ts.txt) is a read-only reference, not a production entrypoint added by this documentation change. The return and history helpers were checked against repository commit `b1937c9c8cc186b349dbb77ade829029d95e302b`. The [manifest](examples/manifest.json) records source and evidence hashes.

## 1. Where the accounts and data came from

1. Combine saved Hyperliquid leaderboard and HyperCore vault-list data, merging addresses present in both sources.
2. Exclude known closed vaults and child vaults. Require **at least $10,000** in discovery account value or vault TVL. This produced 20,869 unique addresses.
3. Fetch each account's `portfolio` history using QuickNode for the first scan, reusing saved official-API responses where available.
4. Process each saved response locally as it arrives. Calculating returns and screening requires no additional API request.

This is coverage of the selected source universe, **not every Hyperliquid address**. The $10,000 discovery gate can miss currently small accounts. It does not require the account to have held $10,000 throughout its history.

Known HyperCore vaults retain that label. Other accounts remain `unverified-account`; this pass does not prove that they are individual traders or rule out other vault types. It does not fetch fills, positions, or a transaction-level deposit ledger. The plan to monitor a smaller set with the official API is separate from this frozen first-pass result.

## 2. What the table's fields mean

| Field | Meaning |
| --- | --- |
| Discovery capital / `seedCapitalUsd` | Account value from the discovery leaderboard, or TVL from the vault list. It is **not starting capital for the historical return**. |
| Portfolio equity / `portfolioEquityUsd` | Latest sampled account value in the fetched portfolio response. It may differ from discovery capital because of timing or scope. |
| Observation period | Actual sampled lookback, up to 90 days. Dates and duration matter; it is not always exactly 90 days. |
| Recent-month return | Compounded return from the sample closest to 30 days before the endpoint, if the resulting period lasts 28–38 days. |
| Best historical period | Highest compounded return among observed start/end pairs at least 30 days apart. Selected in hindsight. |
| Maximum drawdown | Largest peak-to-trough decline in the normalized return series, calculated separately for the full observation window and the best period. |
| PnL in USD | Difference in reported cumulative PnL between the period endpoints. |
| Reasons / flags | Selection triggers and known data or risk concerns. A missing flag is not proof of safety. |

All dates are UTC. Return and drawdown values in JSON are fractions (`0.05` means 5%); HTML and interval CSVs show percentages. None of these returns are annualised.

## 3. Building the observation history

The screening uses **`month` and `allTime`**, not `perpMonth` and `perpAllTime`. These are account-level portfolio results; they must not be labelled as verified perpetual-only trading performance.

- Require valid `month` and `allTime` series, each with at least two samples. Account-value and PnL arrays must have matching timestamps and lengths, in strictly increasing timestamp order. Malformed values or duplicate window names fail validation.
- Set the endpoint to the latest `month` timestamp. The cutoff is the later of endpoint minus 90 days and the first positive account-value timestamp in `allTime`.
- Align the `month` cumulative-PnL baseline to `allTime` using their final PnL difference. Require matching endpoint timestamps and account value, plus agreement at shared timestamps. Value tolerance is `$0.01 + 1e-9 × abs(reference value)`.
- Keep `allTime` samples before the first `month` sample, then use `month` samples. There is no interpolation and no double-counted boundary. The first retained sample can be later than the cutoff, shortening the actual observation period.
- This first-pass screener supplies no stored daily history (`history = null`). Older `allTime` samples are often weekly. Later monitoring can preserve denser history, but cannot recover unobserved intraperiod movements retrospectively.

`fineTimeShare` measures the fraction of elapsed time covered by intervals whose **both endpoints** come from the finer history. It is not the fraction of samples, and “fine” does not guarantee tick-level or daily observations.

Implementation: [parser](../../packages/backend/src/score/parse.ts), [history stitching](../../packages/backend/src/score/stitch.ts).

## 4. Exact return calculation

For two adjacent samples, let `E` be account value and `P` be reported cumulative PnL:

```text
profit_i       = P_i - P_(i-1)
net_flow_i     = E_i - E_(i-1) - profit_i
capital_i      = E_(i-1) + max(net_flow_i, 0)
interval_r_i   = profit_i / capital_i

NAV_0          = 1
NAV_i          = NAV_(i-1) × (1 + interval_r_i)
return[a,b]    = NAV_b / NAV_a - 1
```

This is a **flow-adjusted, compounded return estimate**. It is not `(ending balance / starting balance) - 1`, and not `total dollar PnL / current balance`.

Positive inferred net flows are treated as capital available for the entire interval; negative net flows are treated as leaving at the end. Pure deposits or withdrawals therefore do not themselves generate PnL. But actual cash-flow timing is unknown, and deposits and withdrawals within one interval may cancel in the net figure. This is not transaction-level, exact time-weighted return.

The deposit adjustment keeps the denominator at least as large as starting equity. That helps avoid inflated positive returns from dividing by near-empty capital after a deposit. It does **not** make every result conservative: using a deposit that actually arrived late can understate an earlier percentage loss. See case A below.

### Dust and invalid paths

The shared return helper uses a dust floor of **1% of maximum observed equity across the stitched window**. If `capital_i <= 0` or is below that floor, the helper marks the interval unused and assigns zero return. This research screen sends **any** such skipped interval to `review`; it does not quietly accept the resulting return as a regular candidate.

Non-finite returns, `interval_r_i <= -100%`, non-positive normalized NAV, or overflow also prevent regular candidacy. Both examples below have zero skipped intervals.

Implementation: [interval returns](../../packages/backend/src/score/returns.ts), [configuration](../../packages/backend/src/score/config.ts).

## 5. Best period and drawdown

**Best period:** check every pair of observed endpoints within the lookback with duration at least 30 days. Pick the pair with the highest `NAV_b / NAV_a - 1`; exact ties prefer the longer period. No bad days inside that period are removed. A 30-day-or-longer winning period can still derive most of its gain from one short jump. This is an exploratory, hindsight statistic, not a forecast.

**Recent month:** choose the sample nearest to endpoint minus 30 days; ties choose the earlier sample. Report it only if the actual duration is 28–38 days.

**Sampled drawdown:** within each reported period, reset the running peak at its start:

```text
peak_t = max(NAV_a, ..., NAV_t)
drawdown_t = 1 - NAV_t / peak_t
maximum_drawdown[a,b] = max(drawdown_t for t in [a,b])
```

The main risk window is the full available observation period, up to 90 days; the best-period drawdown is also retained. This uses normalized returns, so inferred withdrawals are not automatically counted as drawdowns. It only sees sampled endpoints and can miss much larger losses between them. These research drawdowns use every stitched sample; formal Score also uses a common evaluation grid, so not every metric is interchangeable.

## 6. Selection rules, in execution order

Thresholds are provisional research choices, not empirically established trading signals. The complete constants are in [the policy JSON](examples/research-screen-v1.policy.json). Order matters: earlier decisions stop evaluation.

| Step | Exact condition | Decision |
| --- | --- | --- |
| 1. Evidence and history | Address/hash mismatch, invalid fetch timestamp, malformed history, insufficient samples, negative stitched equity, invalid return path, or other parsing/calculation error | `review` |
| 2. Quality and age | Stitch/history mismatch, missing valid `allTime`, any unused interval, overflow, stale/future data, a sample gap **>10 days**, or observation **<30 days** | `review` |
| 3. Discovery capital | Discovery value/TVL **<$10,000** | `skip` |
| 4. Latest capital | For an account not known to be a HyperCore vault, latest portfolio equity **<$10,000** | `review`: confirm account type and capital |
| 5. Persistent losses | All conditions in the loss rule below | `skip` |
| 6. Possible inactivity | All conditions in the inactivity rule below | `cold` |
| 7. Positive performance | At least one of the three triggers below | Continue to risk checks |
| 8. Extra risk checks | A positive trigger plus full-period drawdown **≥60%**, any interval **>2 days** with return **≥100%**, or unknown monthly volume | `candidate-review` |
| 9. Regular candidate | Positive trigger with none of those extra risk flags | `candidate` |
| 10. No positive trigger | None of the three performance triggers | `watch` |

**Stale/future data** means any of: fetched more than 5 minutes after evaluation time; last sample more than 5 minutes after fetch time; last sample more than 1 day before fetch time; or evaluation more than 24 hours after fetch time. Frozen rows retain their original evaluation time; they are not fresh monitoring data today.

**Persistent-loss rule:** require at least 80 days of observation. Split the window into three adjacent blocks using the first sample, samples closest to endpoint minus 60 and 30 days, and the endpoint. All boundaries must advance. Each block must last 21–40 days, return **≤−1%**, and have dollar PnL **<−$1**. Full-period return must be **≤−5%**. A final window from the sample nearest endpoint minus 7 days must last 5–10 days and return **≤0%**. Only if all conditions hold is the account skipped.

**Possible-inactivity rule:** the original `month` window must span at least 28 days, contain at least 25 samples, have no gap greater than 2 days, report volume exactly zero, and have a cumulative-PnL range no greater than $1. This produces `cold`, pending a positions/fills check. Zero `perpMonth` PnL or zero volume alone does not prove inactivity or spot-only trading.

**Positive-performance triggers — any one is enough:**

1. Recent-month return **≥5%**, over its actual 28–38-day window.
2. Full-period return **≥10%**, with at least **80 days** of observations.
3. Best historical period return **≥15%**, with that period lasting at least **30 days**.

The ≥100% risk trigger applies to **one interval longer than two days**, not the total compounded return. A `short-history` flag alone does not exclude an account once it has at least 30 days. `skip` means defer further research; evidence remains stored. `watch` and `cold` are not declarations that an account can never become valuable.

## 7. Case A: why a roughly $14k balance shows +5,612%

Address: **`0x3e7c16408c6691e0218167cee78bec7ebad03909`**. [Original evidence](examples/small-capital-account.evidence.json), [frozen result](examples/small-capital-account.expected.json), [every calculation interval](examples/intervals/small-capital-account.intervals.csv).

The apparent “little change” compares **$15,477.87 discovery capital** with **$14,425.06 latest portfolio equity**. These are two near-current snapshots, not the starting and ending capital of the historical return.

| Measurement | Frozen value |
| --- | --- |
| First positive observed equity | **$767.649807**, 22 July 2026, 22:26 UTC |
| Latest observed equity | **$14,425.062292**, 6 October 2026, 10:50 UTC |
| Full observation | **75.5173 days**, 54 intervals |
| Reported PnL increase over that period | **+$22,136.043062** |
| Sum of positive inferred interval net flows | **+$3,900.000000** |
| Sum of negative inferred interval net flows | **−$12,378.630577** |
| Combined inferred net flow | **−$8,478.630577** |
| Full-period compounded return | **+5,598.899969%** |
| Best-period compounded return | **+5,612.125258%**, ending earlier on 6 October at 02:26 UTC |
| Sampled full-period maximum drawdown | **1.865438%** |

The cash arithmetic balances:

```text
$767.649807 + $22,136.043062 - $8,478.630577 = $14,425.062292
starting equity + PnL + inferred net flow = ending equity
```

These are inferred interval flows, **not verified gross deposits and withdrawals**. Likewise, $767.65 is the first positive observed balance, not a claim about the exact original deposit.

### The large returns begin while the account is small

Dates below are UTC; values are rounded for reading. The CSV preserves exact timestamps and decimal calculations.

| Interval in 2026 | Starting equity | PnL change | Inferred net flow | Interval return |
| --- | ---: | ---: | ---: | ---: |
| Jul 22 → Jul 29 | $767.65 | +$164.21 | $0 | +21.3918% |
| Jul 29 → Aug 5 | $931.86 | +$636.49 | $0 | +68.3033% |
| Aug 5 → Aug 12 | $1,568.36 | +$1,098.10 | $0 | +70.0158% |
| Aug 12 → Aug 19 | $2,666.46 | +$1,413.22 | $0 | +52.9999% |
| Aug 19 → Aug 26 | $4,079.67 | +$1,681.90 | −$1,501.01 | +41.2263% |
| Aug 26 → Sep 2 | $4,260.56 | +$1,279.19 | −$600.00 | +30.0239% |

For Aug 19 → Aug 26, balance grows only from $4,079.673491 to $4,260.560671. But the reported PnL increases by $1,681.897180:

```text
net_flow = 4,260.560671 - 4,079.673491 - 1,681.897180
         = -1,501.010000
capital  = 4,079.673491 + max(-1,501.01, 0) = 4,079.673491
return   = 1,681.897180 / 4,079.673491 = +41.226269%
```

The inferred withdrawal explains why the balance changes little while the calculated gain is large. Across all 54 intervals, the normalized growth factor is **56.98899969**:

```text
full return = [product of (1 + interval return) across 54 intervals] - 1
            = 56.98899969 - 1 = +5,598.899969%
```

As another check, the first segment through 5 September compounds to about **11.64909756×**, and the remaining approximately 30.52 days to **4.89213859×**. Multiplying them gives the same full-period factor. This normalized $1-equivalent return does not mean the actual cash balance grew 57×: capital was added and removed along the way.

The best-period search stops at the earlier 02:26 sample, where equity was $15,464.950195, cumulative period PnL was $22,175.930965, and estimated return was +5,612.125258%. Later losses make the full-period return slightly lower.

### Why it passed, and why the result still needs care

Both discovery and latest capital exceed $10,000. The historical $767.65 starting balance is allowed: the maximum sampled equity is $15,464.95, so the 1% dust floor is only **$154.65**. No interval is skipped. Recent-month return is +389.21% and the best period exceeds +15%, satisfying two positive triggers. The full-period trigger is not used because 75.52 days is less than 80.

The largest single interval return is **+70.02%**, below the ≥100% coarse-interval review threshold. Sampled drawdown is below 60%, and monthly volume is known. It therefore receives `candidate`, with `short-history` as its only flag.

**This exposes a limitation of v1:** several very large gains can compound into an extreme result without any single interval triggering review. Older samples are roughly weekly and only **40.41%** of elapsed time has fine coverage. A low sampled drawdown does not establish low trading risk.

Flow timing also matters. Between 14 and 15 September, starting equity is $6,187.145383, PnL change is −$188.169445, and inferred net inflow is +$3,900. The formula reports:

```text
-188.169445 / (6,187.145383 + 3,900) = -1.865438%
```

If that loss occurred before the deposit, its loss relative to the starting balance would be about **3.04%**. We do not know the actual timing. The 1.87% sampled drawdown is reproducible under the formula, not independently verified transaction-level drawdown.

## 8. Case B: a large weekly jump does trigger review

Address: **`0xc44870bb72748b1c1f29cc5f932644253253a8dc`**. [Original evidence](examples/large-weekly-gain-account.evidence.json), [frozen result](examples/large-weekly-gain-account.expected.json), [every calculation interval](examples/intervals/large-weekly-gain-account.intervals.csv).

| Measurement | Frozen value |
| --- | --- |
| Full observation | 8 July 2026, 23:34 → 6 October 2026, 10:41 UTC; **89.4636 days** |
| Starting / ending equity | **$11,486.55 → $130,188.58** |
| Period PnL / inferred net inflow | **+$92,154.19 / +$26,547.83** |
| Full-period compounded return | **+756.937006%** |
| Best period | 8 July → 2 October, **85.3750 days**, **+898.817830%** |
| Full-period sampled maximum drawdown | **38.696020%** |
| Decision | **`candidate-review`**, flag `large-coarse-gain` |

In the approximately seven-day interval from 12 to 19 August:

```text
starting equity = $19,392.533520
ending equity   = $58,320.924672
PnL change      = $40,928.391152
inferred flow   = -$2,000
interval return = 40,928.391152 / 19,392.533520 = +211.052316%
```

This exceeds +100% over an interval longer than two days, so it is excluded from the **regular-candidates** HTML even though its total return is lower than case A's. The decision concerns coarse evidence and risk review; it does not establish that the reported gain is false.

These numbers belong to this saved response. They do not reproduce James's earlier +695% fixture, and this document does not establish a mapping to anonymised `addr-NN` fixtures. Different snapshot endpoints, windows, or input histories must be compared explicitly. None of these figures is APY.

## 9. Reproduce the examples offline

From the repository root, with Python 3 (standard library only):

```bash
python3 docs/ingest/examples/reproduce_returns.py
```

Expected final line:

```text
AUDIT_OK: 2 evidence hashes and all documented period calculations match
```

To regenerate the per-interval spreadsheets:

```bash
python3 docs/ingest/examples/reproduce_returns.py --csv-dir docs/ingest/examples/intervals
```

The audit verifies SHA-256 hashes of the original portfolio response strings and frozen screener source. It independently rebuilds the valid histories using high-precision decimal arithmetic and checks full, recent-month, and best-period returns, PnL, durations, and drawdown values/dates against saved output (numeric tolerance `1e-8`). It refuses skipped/dust/ruin intervals for these two fixtures. No credentials or API calls are needed.

The script's `verified` field means the arithmetic and evidence checks passed. `frozenDecision` is read from the saved result; this audit does not reimplement every screening branch or authenticate upstream data. SHA-256 detects changes to the saved response, not whether the underlying performance is genuine. The source snapshot and decision table document selection separately.

## 10. Handoff to Score and proposed improvements

Research rows deliberately have `score = null` and `eligible = null`. Formal [Score requirements](../../packages/backend/src/score/SPEC.md) still determine eligibility, pool rankings, clone grouping, and finalists. Passing this research screen does not satisfy those checks by itself; account type, fills/activity, data sufficiency, and followability still need evaluation.

Proposals for a **new policy version**, not changes applied to this snapshot:

- Show the actual calculation-start equity, dollar PnL, inferred net flows, and fine-time coverage beside every return.
- Add an explicit review trigger for extreme compounded gains starting from small capital, including sequences of large coarse gains below the current single-interval threshold. Agree thresholds with the team before relabelling results.
- Check sensitivity to cash-flow timing and preserve denser daily history going forward.
- Verify positions, fills, account type, and deposit/withdrawal events for the narrowed set before treating unusual performance as a copyable strategy.

Keep this version and its evidence frozen so later policy changes can be compared rather than silently replacing the shared results.

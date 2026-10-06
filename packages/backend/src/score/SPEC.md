# Score module spec (README section 4.2)

Status: **revision 2 (2026-10-06), ahead of the code.** The code in `src/score/` still implements revision 1; it changes
to match this file in a follow-up. Revision 2 records the decisions from the review of PR #2 (see "Revision 2 decisions
and evidence" at the end). Values marked **[tune]** are provisional and are set in the tuning session on 2026-10-07.
Where the README is silent, a choice is marked **[interpretation]**.

## What it does
`scoreCandidates(inputs, config?)` takes one record per address (the data `ingest` produces), applies the hard filters,
builds a 90-day return series per address from the Hyperliquid `portfolio` windows, computes risk-adjusted metrics,
ranks eligible addresses by a weighted average percentile **within their pool** (traders, vaults), and returns the
finalists, a funnel and per-filter counts.

It is a pure, deterministic function: no I/O, no network, no clock, no randomness, no new dependencies.
Ingest, persistence and the AI review are out of scope; the adapter to the review's `candidate-curation-frame` is
specified in "Frame adapter". Before the finalist cut, accounts that run the same strategy are grouped so each finalist
slot is a distinct strategy ("Clone grouping").

## Types (exported from `src/score/index.ts`)
```ts
export type Kind = "trader" | "hypercore-vault" | "erc4626-vault";
export type Pool = "trader" | "vault"; // hypercore-vault and erc4626-vault share the vault pool
export type TimePoint = readonly [tsMs: number, value: number];
export type WindowHistory = { accountValueHistory: TimePoint[]; pnlHistory: TimePoint[] };

export type ScoreInput = {
  address: string;
  kind: Kind;
  accountValue: number;          // current account value / TVL in USD
  closed: boolean | null;        // null = unknown
  month: WindowHistory | null;   // Hyperliquid `portfolio` "month" window
  allTime: WindowHistory | null; // Hyperliquid `portfolio` "allTime" window
  history: WindowHistory | null; // month-resolution points older than `month`, from ingest's daily snapshots,
                                 // PnL already in the allTime baseline (see "Snapshots"); null = none stored
  tradeCount: number | null;     // from fills; null = unknown
  links?: string[];              // addresses known to be the same operator (vault <-> leader from `vaultDetails`,
                                 // sub-accounts); grouped as clones regardless of correlation. See "Clone grouping".
  // Fill-derived values are copied to the output unchanged. Score does not compute them.
  avgLeverage?: number | null;
  timeInMarket?: number | null;
  medianHoldHours?: number | null;
  makerShare?: number | null;
};

export type FilterName =
  | "minAccountValue" | "minActiveDays" | "stillActive" | "minTrades"
  | "notClosed" | "minMonthPoints" | "minCoverage" | "noRuin";
export type FilterStatus = "pass" | "fail" | "unknown";

// A ratio with a zero denominator and a positive numerator is "+inf" (better than every number);
// with a zero or negative numerator it is null (worse than every number). Never NaN or Infinity.
export type Ratio = number | "+inf" | null;

export type Metrics = {
  sharpe: Ratio;                     // per sqrt(day), not annualised
  sortino: Ratio;                    // per sqrt(day), not annualised
  calmar: Ratio;                     // periodReturn / maxDrawdown
  maxDrawdown: number | null;        // 0..1 over the lookback, higher is worse
  consistency: number | null;        // equity-curve R², 0..1
  periodReturn: number | null;       // compounded return over the covered lookback
  annualisedReturn: number | null;   // reported only
  annualisedVol: number | null;      // reported only
  realizedVol: number | null;        // per sqrt(day), reported only
  allTimeMaxDrawdown: number | null; // over the whole allTime window, reported only, not ranked
  lookbackDays: number;              // span of the stitched series (<= config.lookbackDays)
  coveredDays: number;               // T: total length of the intervals used
  skippedTimeShare: number;          // share of the span in skipped (dust) intervals, 0..1
  fineTimeShare: number;             // share of the span at month resolution, 0..1
  flags: string[];
};

export type Percentiles = { sharpe: number; sortino: number; calmar: number; negMaxDrawdown: number; consistency: number };

export type Candidate = {
  address: string;
  kind: Kind;
  pool: Pool;
  activeDays: number | null;         // see "Filters"; null without activeStart
  filters: Record<FilterName, FilterStatus>;
  eligible: boolean;
  metrics: Metrics | null;           // null only when the month series is missing or invalid
  percentiles: Percentiles | null;   // within the pool; null unless ranked
  scoreNumerator: number | null;     // integer; null unless ranked
  score: number | null;              // 0..1; null unless ranked
  rank: number | null;               // 1-based within the pool; null unless ranked
  cloneOf: { address: string; correlation: number | null } | null; // set on a clone; correlation null = linked
  clones: string[];                  // on a representative: the addresses grouped under it, in cross-pool order
  finalist: boolean;
  passthrough: { avgLeverage: number | null; timeInMarket: number | null; medianHoldHours: number | null; makerShare: number | null };
};

export type FunnelStage = "universe" | FilterName | "eligible" | "distinct" | "finalists";
export type FunnelStep = { stage: FunnelStage; count: number };
export type FilterCounts = Record<FilterName, { pass: number; fail: number; unknown: number }>;

export type ScoreConfig = {
  minAccountValue: number;       // 10000
  minActiveDays: number;         // 30
  stillActiveDays: number;       // 7     [tune]
  minTrades: number;             // 10
  minMonthPoints: number;        // 25
  lookbackDays: number;          // 90    [tune]
  coarseGridDays: number;        // 7
  dustEquityFraction: number;    // 0.01  [tune]
  maxSkippedTimeShare: number;   // 0.20  [tune]
  cloneCorrelation: number;      // 0.90  [tune]
  minOverlapDays: number;        // 20
  finalists: number;             // 25
  finalistSplit: "proportional" | { trader: number; vault: number }; // "proportional" [tune]
  allowUnknown: FilterName[];    // []. See "Eligibility".
};

export function scoreCandidates(
  inputs: ScoreInput[],
  config?: Partial<ScoreConfig>,
): {
  candidates: Candidate[];
  finalists: string[];
  correlations: { a: string; b: string; rho: number | null; linked: boolean }[]; // every finalist pair, a before b
  funnel: FunnelStep[];
  filterCounts: FilterCounts;
  config: ScoreConfig;
};

// Metrics for one input (stitching, returns and metrics below); null when `month` is missing or invalid.
export function computeMetrics(input: ScoreInput, config?: Partial<ScoreConfig>): Metrics | null;

export function parsePortfolio(raw: unknown): { month: WindowHistory | null; allTime: WindowHistory | null };
```

## parsePortfolio
Input is the raw Hyperliquid `portfolio` response: a list of `[windowName, { accountValueHistory, pnlHistory, vlm }]`
where each history is `[[tsMs, "decimal string"], ...]`. Use only the windows named exactly `month` and `allTime`
(ignore `day`, `week`, `perp*`). Convert strings to numbers. Return `null` for a window that is absent.
Throw an `Error` whose message starts with `portfolio:` for anything malformed: not an array, a bad entry, a non-finite
number, a non-integer timestamp, a string that is not a plain decimal (optional sign, digits with an optional decimal
point such as `5.` or `.5`, no exponent), or **a window name that appears twice** (`portfolio: duplicate window month`).
It does not check ordering or alignment; scoring does.

## Series validation
A window history is valid only if `accountValueHistory` and `pnlHistory` have the same length (>= 2), the same
timestamps at every index, and strictly increasing timestamps. This applies to `month`, `allTime` and `history`.
An invalid or missing `month` gives `metrics = null`, and the filters that need it (`stillActive`, `minMonthPoints`,
`minCoverage`, `noRuin`) are `unknown`. Such a candidate is never ranked, even when `allowUnknown` makes it eligible.

## Lookback and stitching
The ranking metrics use one series per address covering at most `lookbackDays` (90) days, built from three sources in
order of preference: `month` (about 16 hours between points), `history` (same resolution, older), `allTime` (coarser:
about 1 day apart for accounts a few months old, 7 days for most, 14 days for accounts older than 2 years).

**Baselines.** `month` PnL starts at 0 at the window start; `allTime` PnL is cumulative since the account started.
Both windows end at the same timestamp, so `offset = allTime.pnl[last] - month.pnl[last]` puts `month` into the allTime
baseline: `pnl'_i = month.pnl_i + offset`. On the 24 fixture accounts every `allTime` point that shares a timestamp
with a `month` point matches `pnl'` to within 1e-9 USD.

**Window.** `E` is the last `month` timestamp. `activeStart` is the first point of a valid `allTime` with account
value > 0 (none if `allTime` is missing or invalid, or has no such point).
`S = max(E - lookbackDays * 86_400_000, activeStart)` (without `activeStart`, `S = E - lookbackDays * 86_400_000`); if `activeStart > E - lookbackDays * 86_400_000`, add the
flag `short-history` (the account is scored on the history it has; `minActiveDays` still requires 30 days).

**Alignment checks.** Tolerance: `|a - b| <= 0.01 + 1e-9 * |b|` (USD). Stitching with `allTime` requires that both
windows are valid, end at the same timestamp with matching account value, and agree (account value and `pnl'`) at
every shared timestamp. If `allTime` is missing or invalid, add `no-alltime`; if it is valid but fails these checks, add
`stitch-mismatch`. In both cases `allTime` is not used: `month` keeps its own PnL baseline (no offset) and `history`
is dropped (its baseline cannot be joined), so the series is `month` alone. When `allTime` is used, a non-null
`history` must be valid and agree (account value and PnL, no offset) with `allTime` and with `month` (`pnl'`) at every
shared timestamp; otherwise it is dropped and adds `history-mismatch`.

**Series.** In time order, keeping only points with `ts >= S`:
1. `allTime` points with `ts` before the first kept `history` point (or before the first `month` point if there is no
   `history`): **coarse**;
2. `history` points with `ts` before the first `month` point: **fine**;
3. all `month` points (with `pnl'`): **fine**.

An interval is fine only if both of its end points are fine. `lookbackDays` (output) is the span of the series,
`(ts_last - ts_first) / 86_400_000`; `fineTimeShare` is the summed `dt` of fine intervals (used or skipped) divided by
that span. Add `coarse-history` if any coarse interval is longer than
`1.5 * coarseGridDays`.

## Returns
Over consecutive points `i = 1..n-1` of the series:
- `dt_i = (ts_i - ts_{i-1}) / 86_400_000` (days)
- `dpnl_i = pnl_i - pnl_{i-1}`
- `flow_i = (accountValue_i - accountValue_{i-1}) - dpnl_i` (net deposits minus withdrawals in the interval)
- `capital_i = accountValue_{i-1} + max(flow_i, 0)` **[interpretation]**: a deposit is assumed to have been at work for
  the whole interval and a withdrawal to have happened at its end, so `capital_i` is never below the starting equity
  and returns are never inflated by flows.
- `r_i = dpnl_i / capital_i`

**Dust guard.** `peak` is the largest account value in the series. An interval with
`capital_i <= 0` or `capital_i < dustEquityFraction * peak` is skipped and adds `dust-equity`.
`skippedTimeShare = sum(dt of skipped) / sum(dt of all)`. `T = sum(dt of used)`. If no interval is used or `T == 0`,
add `no-intervals`: `sharpe`, `sortino`, `calmar`, `maxDrawdown`, `consistency`, `periodReturn`, `annualisedReturn`,
`annualisedVol` and `realizedVol` are `null`; `lookbackDays`, `coveredDays` (0), `skippedTimeShare`, `fineTimeShare`
and `allTimeMaxDrawdown` are still reported.

## Metrics
With `mu = sum(r) / T` (mean return per day):
- `sd = sqrt(sum((r_i - mu * dt_i)^2) / T)` and `dd = sqrt(sum(min(r_i, 0)^2) / T)` (minimum acceptable return 0).
- `sharpe = ratio(mu, sd)`, `sortino = ratio(mu, dd)`, where `ratio(x, y)` is `x / y` for `y > 0` (a non-finite result
  is `null`), `"+inf"` for `y == 0, x > 0`, and `null` for `y == 0, x <= 0`. Add `no-downside` when `dd == 0, mu > 0`.
- Compounded curve: `C_0 = 1` at the first series point; after each used interval `C = C * (1 + r_i)`, recorded at
  `ts_i`. If `1 + r_i <= 0`, `C = 0` from then on and add `ruin`.
- `periodReturn = C_last - 1`.
- The **curve value at time t** is the value of the last curve point at or before `t` (`C_0` at the first series point).
- `maxDrawdown = max (peak_j - C_j) / peak_j` (with `peak_j` the running maximum, so the result is in 0..1) over the
  **drawdown points**, in time order. With `fineStart` the start time of the first fine interval: the curve value at
  `ts_0 + k * coarseGridDays * 86_400_000` for `k = 0, 1, ...` while that time is `< fineStart`; then the curve value at
  `fineStart`; then every curve point with `ts > fineStart`. Without coarse intervals `fineStart = ts_0`. This puts the coarse part of every account on the
  same 7-day grid, so accounts with daily `allTime` points are not penalised against accounts with fortnightly ones.
- `calmar = ratio(periodReturn, maxDrawdown)`. Add `no-drawdown` when `maxDrawdown == 0, periodReturn > 0`.
- `consistency` **[interpretation]** (README: "PnL consistency"): over all curve points (including `C_0`),
  `x_j = (ts_j - ts_0) / 86_400_000`, `y_j = ln(C_j)`; fit `y = a + b x` by least squares;
  `consistency = 0` if `b <= 0`, else `R² = S_xy² / (S_xx * S_yy)`. `null` if `S_yy == 0` (a flat curve) or `ruin`.
  A steady uptrend scores near 1; returns from a single jump, or a deep drawdown and recovery, score low.
- `realizedVol = sd`; `annualisedVol = sd * sqrt(365)`;
  `annualisedReturn = C_last^(365 / T) - 1` (`-1` after `ruin`; non-finite is `null`).
  Sharpe and Sortino are **never annualised** in the output: scaling a 90-day ratio by sqrt(365) overstates how reliable it is.
- `allTimeMaxDrawdown`: the same returns, dust guard and compounding over the whole valid `allTime` window at its own
  resolution (no grid), then the drawdown over all curve points. `null` without a valid `allTime`.

Every number in `Metrics` is finite or `null`; a repeated flag appears once; flags are sorted.

## Filters (each returns pass / fail / unknown), in funnel order
- `minAccountValue`: `accountValue >= minAccountValue` (non-finite value: `unknown`).
- `minActiveDays`: `activeDays = (lastTs - activeStart) / 86_400_000` from the valid `allTime`. `allTime` missing or
  invalid: `unknown`. No point with value > 0: `fail`. Pass if `activeDays >= minActiveDays`. **[interpretation]**
- `stillActive`: pass if some `month` interval with `ts_i >= E - stillActiveDays * 86_400_000` has `dpnl_i != 0`;
  otherwise `fail`. Invalid `month`: `unknown`.
- `minTrades`: `tradeCount === null` -> `unknown`; else pass if `>= minTrades`.
- `notClosed`: `closed === null` -> `unknown`; `false` -> pass; `true` -> fail.
- `minMonthPoints`: invalid `month` -> `unknown`; else pass if its number of points `>= minMonthPoints`.
- `minCoverage`: invalid `month` -> `unknown`; `no-intervals` -> `fail`; else pass if
  `skippedTimeShare <= maxSkippedTimeShare`, otherwise `fail` with the flag `low-coverage`.
- `noRuin`: invalid `month` -> `unknown`; `ruin` -> `fail`; else pass.

## Eligibility (fail-closed)
`eligible` is true only if every filter is `pass`, or `unknown` for a filter listed in `allowUnknown`. A `fail` is never
overridden. The default `allowUnknown` is `[]`. Real data has no trade counts until fills are ingested, so a run before
that sets `allowUnknown: ["minTrades"]`, and ingest fetches fills only for addresses that pass the other filters.

## Ranking
A candidate is **ranked** if it is eligible and has non-null `metrics` without `no-intervals`. Ranked candidates are
split into pools by `pool`; each pool of size N is ranked on its own.

Five terms, each "higher is better", with integer weights:

| Term | Weight | Block |
|---|---|---|
| `sharpe` | 1 | risk-adjusted return (1/3) |
| `sortino` | 1 | risk-adjusted return |
| `calmar` | 1 | drawdown (1/3) |
| `negMaxDrawdown = -maxDrawdown` | 1 | drawdown |
| `consistency` | 2 | consistency (1/3) |

Order of values: `"+inf"` is better than every number, `null` is worse than every number, equal values tie
(`"+inf"` ties with `"+inf"`, `null` with `null`).
- Exact integer ranking. For a value, `L` is the number of values in the pool strictly worse and `E` the number equal to
  it (including itself). Its **rank numerator** is `k = 2L + E - 1`, an integer in `0 .. 2(N-1)`.
  Percentile = `k / (2(N - 1))`.
- `scoreNumerator = sum(weight * k)`, an integer in `0 .. 12(N-1)`. `score = scoreNumerator / (12(N - 1))`.
  For `N == 1` every percentile and the score are `0.5` and `scoreNumerator = 0`.
- Order within the pool: `scoreNumerator` descending (integers); then raw `sharpe` descending (same value order as
  above); then `address` ascending (lower-cased). Never order by the floating-point `score` or by a sum of floating-point
  percentiles. `rank` is the 1-based position in the pool.
- Implementation requirement: `rankPool(entries: { address: string; metrics: Metrics }[])` is a separate exported
  function in `score.ts` (not re-exported from `index.ts`) so tests can feed hand-made metrics.

**Cross-pool order** (used for the finalist list and the output): compare `score` exactly as fractions
`scoreNumerator / (12(N-1))` (`1/2` for `N == 1`) by cross-multiplying integers; ties by raw `sharpe`, then address.

## Clone grouping
Two accounts running the same strategy (copies, sub-accounts, a vault and its leader's own account) would take several
finalist slots and concentrate the copy portfolio in one strategy's idiosyncratic risk. Clones are grouped **before**
the finalist cut, across both pools, so every slot goes to a distinct strategy.

**Daily returns.** For each ranked candidate, the fine span runs from `fineStart` (see "Metrics") to the last series
point. Take the curve value (see "Metrics") at every UTC midnight (`ts % 86_400_000 == 0`) inside the fine span, both
ends included; `d_k = ln(C_k / C_{k-1})` for consecutive midnights, keyed by the later midnight. A day whose sample is 0 (after `ruin`) is not
used (ruined accounts are not ranked anyway).

**Correlation.** For two candidates, use the midnights both have; if there are fewer than `minOverlapDays` daily returns
in common, or either side has zero variance, the pair has no correlation (`null`) and is not grouped by correlation.
Otherwise `rho = sum((x - mean_x)(y - mean_y)) / sqrt(sum((x - mean_x)^2) * sum((y - mean_y)^2))` over the common
days (zero variance means a sum of squared deviations exactly 0). The same `rho` is reported in `correlations`.

**Greedy grouping** (deterministic). Walk the ranked candidates in cross-pool order. A candidate becomes a **clone**
of the first earlier **representative** (in cross-pool order) that it is linked to (either side lists the other in
`links`, compared lower-cased) or with which `rho >= cloneCorrelation`; a link is recorded with `correlation: null`
even when `rho` is also high. Otherwise it becomes a representative. Comparisons are only
against representatives, never against clones, so groups cannot chain. A clone gets
`cloneOf = { address, correlation }` (`correlation: null` for a link); its representative lists it in `clones`.
Clones keep their percentiles, score and rank (they describe the account), but they are never finalists.

On the fixtures with the prototype (16 ranked), the default 0.9 gives 12 distinct strategies: `addr-06` (rho 0.991)
and `addr-02` (0.944) -> `addr-04`; `addr-24` (0.931) -> `addr-18`; `addr-17` (0.940) -> `addr-23`. At 0.8 it would
be 9 (`addr-02`, `-04`, `-06` -> `addr-09` at 0.80-0.88; `addr-16` -> `addr-13`; `addr-19` -> `addr-23`); at 0.7, 8.
With 30 daily returns a measured rho of 0.9 has a 95% interval of about 0.80-0.95, and 0.8 about 0.62-0.90; the
overlap, and so the precision, grows as snapshots accumulate.

Grouping removes near-duplicates only. Correlation between distinct finalists (below the threshold) is still the
agent's job (README 4.6) through the frame's `pairs` correlation matrix.

## Finalists
**Finalist slots.** `F = config.finalists`, `R_trader`, `R_vault` = the number of **representatives** in each pool.
If `R_trader + R_vault <= F`, every representative is a finalist. Otherwise each pool gets `s_pool` slots and its top
`s_pool` representatives by rank are finalists:
- `"proportional"` (provisional default, **[tune]**): `q = F * R_pool / (R_trader + R_vault)`; `s = floor(q)`; the
  remaining slots go one at a time to the pool with the larger fractional part (`trader` first on a tie); a pool with
  `R_pool > 0` and `s = 0` takes one slot from the other pool if that pool has at least 2 slots.
- `{ trader, vault }`: fixed slots that must sum to `F`; slots a pool cannot fill go to the other pool.

## Output
`candidates`: ranked candidates in cross-pool order, then all others sorted by address. `finalists`: finalist
addresses in cross-pool order. `correlations`: one entry per pair of finalists `(a, b)` with `a` before `b` in
`finalists`, in that order (by `a`, then `b`); `rho` as in "Clone grouping", `linked` when either lists the other in
`links`. Addresses are compared case-insensitively; two inputs with the same lower-cased address
make `scoreCandidates` throw `Error("duplicate address: ...")`.
`funnel`, in order: `universe` (all inputs); after each filter in funnel order, the number of candidates that pass that
filter and all earlier ones (`unknown` counts as passed only for filters in `allowUnknown`); `eligible` (ranked
candidates); `distinct` (representatives after clone grouping); `finalists`. Counts never increase along the funnel.
`filterCounts`: for each filter on its own, how many candidates are `pass`, `fail` and `unknown` (shows which filter
does the work, independent of funnel order).
Empty input returns empty `candidates` and `finalists`, a `universe` count of 0, zero counts after it and zero
`filterCounts`.

Invalid config throws, and the error names the field: `finalists`, `minMonthPoints`, `lookbackDays` must be integers
>= 1; `coarseGridDays` > 0; `dustEquityFraction` and `maxSkippedTimeShare` in [0, 1]; `cloneCorrelation` in
(0, 1]; `minOverlapDays` an integer >= 3; the other thresholds finite and
>= 0 (a non-integer `minTrades` is allowed); fixed `finalistSplit` values non-negative integers summing to `finalists`;
`allowUnknown` entries must be filter names.

## Snapshots (ingest, README 4.1)
Hyperliquid serves `month` at about 16-hour resolution but older history only through the coarse `allTime` window.
Ingest therefore saves, once a day for every address it tracks, each `month` point as
`(address, tsMs, accountValue, pnlAllTimeBaseline)`, with `pnlAllTimeBaseline = month.pnl + offset` computed from the
same response (see "Baselines"). Rows are keyed by `(address, tsMs)`; a re-fetched row must agree within the tolerance
above, or ingest keeps the newer row and logs the mismatch. Score receives the stored rows older than the current
`month` window as `history`. After 60 days of snapshots, the 90-day lookback is at month resolution for every
tracked address.

## Frame adapter (review `candidate-curation-frame`)
The review workflow consumes `packages/shared/schemas/candidate-curation-frame.schema.json`. Its `oos*` and
`crossWindowStability` fields mean **out-of-sample** (from the backtest). Score's metrics are in-sample and must not be
put there. The adapter (`src/score/frame.ts`, `toFrameCandidates`) fills only the fields Score owns; other modules fill
the rest. This needs schema version `1.1.0` with seven new fields:

| Frame field | From Score |
|---|---|
| `candidate` | position in `finalists` (0-based) |
| `kind` | `trader` -> `TRADER`, `hypercore-vault` -> `HYPERCORE_VAULT`, `erc4626-vault` -> `ERC4626_HYPERCORE` |
| `historyDays` | `activeDays` |
| `maxDrawdown` | `metrics.maxDrawdown` |
| `pnlConsistency` | `metrics.consistency` (`null` -> 0) |
| `averageLeverage`, `timeInMarket`, `makerShare` | passthrough |
| `medianHoldMinutes` | passthrough `medianHoldHours * 60` |
| **new** `isSharpe`, `isSortino`, `isCalmar` | the ratio; `"+inf"` -> `null` (the reason is in `scoreFlags`) |
| **new** `lookbackDays` | `metrics.lookbackDays` |
| **new** `scoreFlags` | `metrics.flags` |
| **new** `clones` | `clones` (addresses grouped under this finalist), so the agent sees what was merged |
| `pairs[].correlation`, `pairs[].linkedSource` | `correlations[].rho` and `.linked`, with `a`/`b` as finalist positions |
| `oosWindows`, `oosSharpe`, `oosSortino`, `oosMaxDrawdown`, `crossWindowStability` | not from Score: `0` / `null` until the backtest supplies them |

Consequence: `review/workflow.ts` rejects a candidate with `oosSharpe === null`, so no candidate passes the review
gate until the backtest supplies out-of-sample values. This is intended.

## Code conventions (match `packages/backend`)
TypeScript strict, ESM, extensionless imports, double quotes, semicolons, trailing commas, `const` arrow-function
exports, no `any`, tests with `bun:test` in `test/score/*.test.ts`, comments cite the README section.
Files: `src/score/{types,parse,stitch,returns,metrics,filters,score,clones,frame,index}.ts`.

## To decide in tuning (2026-10-07)
- The **[tune]** values: `lookbackDays` 90, `stillActiveDays` 7, `dustEquityFraction` 0.01, `maxSkippedTimeShare`
  0.20, `cloneCorrelation` 0.90, and the `finalistSplit` between traders and vaults (to be set after seeing how live traders and vaults differ).
- **Near-cash accounts rank first.** In the fixture prototype, `addr-21` (+0.4% over 82 days, 0.1% drawdown, R² 0.94)
  ranks #1. All five terms are risk-adjusted or shape-based, so an account with almost no risk and almost no return
  wins. A return hurdle (minimum `annualisedReturn`) or a return term may be needed.
- **Clone threshold.** At 0.9, `addr-09` and the `addr-04` group (rho 0.80-0.88 between them) stay separate
  finalists. Decide with live data whether that cluster is one strategy; 0.8 would merge it.
- **Old accounts are coarser.** Accounts older than about 2 years have 14-day `allTime` points (flag
  `coarse-history`) until snapshots accumulate.

## Revision 2 decisions and evidence
Evidence is from the 24 public `month`/`allTime` windows in `test/fixtures/score/portfolio-sample.json` and a Python
prototype of this revision (outside the repo).

| # | Revision 1 | Revision 2 | Why |
|---|---|---|---|
| 1 | 4 equal terms: Sortino, Calmar, -MDD, positive-day share | 3 equal blocks: (Sharpe, Sortino), (Calmar, -MDD), consistency | README groups "Calmar / -max drawdown" as one item; 4 equal terms gave drawdown ~1/2 of the weight. Sharpe is defined where Sortino is not, but Sharpe and Sortino rank 22 accounts almost identically (Spearman 0.988), so they share a block. Calmar vs -MDD: 0.265, so both are kept. |
| 2 | Share of UTC days with positive PnL | Equity-curve R² (0 if the trend is down) | The day share is a hit rate that ignores size, so martingale-like accounts score high; on the fixtures it spans only 0.35-0.65. |
| 3 | allTime span >= 30 days | Same, plus `stillActive` (PnL change in the last 7 days) | Dormant accounts were eligible (`addr-10`: no PnL change all month). |
| 4 | `r = dpnl / equity at start` | `capital = start + max(flow, 0)`, dust guard against the series peak | `addr-08` started an interval with $0.09 and deposited $121k: r = 23,479x, Sortino 46,407, ranked #6 in revision 1. Modified Dietz was rejected: `addr-14` (made $1,134 on $1,173, withdrew $2,300) gives +4,885% in one interval. The dust reference is the peak, not the median: `addr-08` sat at ~$0.08 for 75 of 90 days, so its median is dust. |
| 5 | `allowUnknown: boolean` | `allowUnknown: FilterName[]` | Relax only the filter whose data is missing (trade counts before fills are ingested). |
| 6 | Undefined ratio = `null`, ranks worst | Positive / 0 = `"+inf"`, ranks best; 0/0 = `null` | `addr-21` never had a losing interval in the month and ranked last on Sortino and Calmar. |
| 7 | Not annualised | Ratios still not annualised; annualised return and volatility reported | A 30/90-day Sharpe scaled by sqrt(365) looks far more reliable than it is (`addr-21` over the 30-day month: 7.3 per sqrt(day) -> ~140 per year). |
| 8 | Ties by address | Ties by raw Sharpe, then address | The address string should not decide the last finalist slot. |
| 9 | Score's own record, no adapter | Adapter to frame 1.1.0 with in-sample fields | Putting in-sample metrics in `oos*` would label them as validated. |
| - | `month` window only (30 days) | 90-day stitched lookback; snapshots in ingest | Team decision: 30 days is a minimum, not the lookback. The `month`/`allTime` offset is exact (24/24 accounts). |
| - | Ruin ranked with curve 0 | Ruin is ineligible (`noRuin`) | An account that lost everything in the lookback is not a copy source. |
| - | (none) | `minCoverage`: <= 20% of time in dust intervals | Excludes `addr-08`, which traded for only ~2 weeks of the window. |
| - | (none) | `allTimeMaxDrawdown` reported | Shows the agent a blow-up older than the lookback. |
| - | Cumulative funnel only | Plus `filterCounts` per filter | Shows which filter does the work. |
| - | One ranking | Percentiles within pool (traders, vaults) | HyperCore vaults (legacy, profit share, lockups) have different return profiles. |
| - | Duplicate window: last wins | Throws | A duplicated window is a malformed response. |
| - | (none) | Clone grouping before the finalist cut: rho >= 0.9 on daily returns, or a known link | `addr-02`, `-04`, `-06`, `-09` (daily-return rho 0.80-0.99; `addr-04`/`-06` 0.991 with the same account value) took 4 of the top 6 places. Duplicates concentrate the copy portfolio in one strategy's idiosyncratic risk; widening the finalist set would only spend more slots on them. |

Prototype funnel on the fixtures (synthetic `closed`/`tradeCount` overlay): 24 -> 23 (account value) -> 23 -> 22 (still
active) -> 17 (trades) -> 17 -> 17 -> 16 (coverage: `addr-08`) -> 16 ranked -> 12 distinct -> 12 finalists.

## Other decisions made without a README basis (unchanged from revision 1)
- Sortino uses a minimum acceptable return of 0 and per-day normalisation by elapsed time.
- Arithmetic that overflows to a non-finite number becomes `null`.
- The thresholds default to the README numbers ($10,000, 30 days, 10 trades, 25 points, top 25).
- A non-finite `accountValue` gives `unknown`. `allTime` with no point above 0 gives `fail` for active days.
- A candidate with `eligible: true` can still be unranked when its month series is invalid (`allowUnknown` only).
- Ranking is by exact integer numerators; the order of the input never matters.
- Addresses are compared case-insensitively, and two inputs that differ only by case throw `duplicate address`.
- The funnel counts candidates that passed each filter and all earlier ones.
- Pure functions in `packages/backend/src/score/`, nothing exported from a package entry point, no new dependencies.
- Fill-derived values (`tradeCount`, `avgLeverage`, `timeInMarket`, `medianHoldHours`, `makerShare`) are inputs that a
  future ingest supplies. Score only passes them through.
- Fixture addresses are replaced by `addr-NN`. `closed` and `tradeCount` in `portfolio-sample.json` are synthetic.

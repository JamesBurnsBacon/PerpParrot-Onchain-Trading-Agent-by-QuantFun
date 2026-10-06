# Score module spec (README section 4.2)

Status: draft. This file is the single source of truth for the implementation in `src/score/`.
Where the README is silent, the choice below is marked **[interpretation]** and is open for the team to change.

## What it does
`scoreCandidates(inputs)` takes one record per address (the data `ingest` will produce), applies the hard
filters, computes metrics from the PnL history, ranks eligible addresses by an average percentile score and
returns the top K (default 25) as finalists, plus a funnel (count after each filter).

It is a pure, deterministic function: no I/O, no network, no clock, no randomness, no new dependencies.
Ingest, persistence and the shape handed to the AI review are out of scope.

## Types (exported from `src/score/index.ts`)
```ts
export type Kind = "trader" | "hypercore-vault" | "erc4626-vault";
export type TimePoint = readonly [tsMs: number, value: number];
export type WindowHistory = { accountValueHistory: TimePoint[]; pnlHistory: TimePoint[] };

export type ScoreInput = {
  address: string;
  kind: Kind;
  accountValue: number;          // current account value / TVL in USD
  closed: boolean | null;        // null = unknown
  month: WindowHistory | null;   // Hyperliquid `portfolio` "month" window
  allTime: WindowHistory | null; // Hyperliquid `portfolio` "allTime" window
  tradeCount: number | null;     // from fills; null = unknown
  // Fill-derived values are copied to the output unchanged. Score does not compute them.
  avgLeverage?: number | null;
  timeInMarket?: number | null;
  medianHoldHours?: number | null;
  makerShare?: number | null;
};

export type FilterName = "minAccountValue" | "minActiveDays" | "minTrades" | "notClosed" | "minMonthPoints";
export type FilterStatus = "pass" | "fail" | "unknown";

export type Metrics = {
  sortino: number | null;
  calmar: number | null;
  maxDrawdown: number | null;    // 0..1, higher is worse
  pnlConsistency: number | null; // 0..1
  realizedVol: number | null;    // reported only, not ranked
  flags: string[];
};

export type Candidate = {
  address: string;
  kind: Kind;
  filters: Record<FilterName, FilterStatus>;
  eligible: boolean;
  metrics: Metrics | null;       // null only when the month series is invalid or missing
  percentiles: { sortino: number; calmar: number; negMaxDrawdown: number; pnlConsistency: number } | null;
  score: number | null;          // null unless eligible
  rank: number | null;           // 1-based, null unless eligible
  finalist: boolean;
  passthrough: { avgLeverage: number | null; timeInMarket: number | null; medianHoldHours: number | null; makerShare: number | null };
};

export type FunnelStage = "universe" | FilterName | "eligible" | "finalists";
export type FunnelStep = { stage: FunnelStage; count: number };

export type ScoreConfig = {
  minAccountValue: number;   // 10000
  minActiveDays: number;     // 30
  minTrades: number;         // 10
  minMonthPoints: number;    // 25
  finalists: number;         // 25
  allowUnknown: boolean;     // false. See "Eligibility".
};

export function scoreCandidates(
  inputs: ScoreInput[],
  config?: Partial<ScoreConfig>,
): { candidates: Candidate[]; finalists: string[]; funnel: FunnelStep[]; config: ScoreConfig };

export function parsePortfolio(raw: unknown): { month: WindowHistory | null; allTime: WindowHistory | null };
```

## parsePortfolio
Input is the raw Hyperliquid `portfolio` response: a list of `[windowName, { accountValueHistory, pnlHistory, vlm }]`
where each history is `[[tsMs, "decimal string"], ...]`. Use only the windows named exactly `month` and `allTime`
(ignore `day`, `week`, `perp*`). Convert strings to numbers. Return `null` for a window that is absent.
Throw an `Error` whose message starts with `portfolio:` for anything malformed (not an array, bad entry,
non-finite number, non-integer timestamp). It does not check ordering or alignment; scoring does.

## Series validation
A window history is valid only if `accountValueHistory` and `pnlHistory` have the same length (>= 2), the same
timestamps at every index, and strictly increasing timestamps. An invalid month series gives
`minMonthPoints = "unknown"`, `metrics = null` and is never eligible unless `allowUnknown` is true and no filter
fails; even then `metrics` stays `null`, so it cannot be ranked and is excluded from ranking and finalists.

## Returns
Over consecutive points `i = 1..n-1` of the month window:
- `dt_i = (ts_i - ts_{i-1}) / 86_400_000` (days)
- `r_i = (pnl_i - pnl_{i-1}) / accountValue_{i-1}`

Use only intervals with `accountValue_{i-1} > 0` (other intervals are skipped and add the flag
`zero-equity-interval`). `T = sum(dt_i)` over used intervals. If no interval is used, or `T == 0`, all metrics are
`null` with the flag `no-intervals`. Deposits and withdrawals change `accountValue` but not `pnl`, so they never
create a return. **[interpretation]**: the denominator is the account value at the start of the interval.

## Metrics (month window, no annualisation, the ranking does not need it)
- `sortino = (sum(r)/T) / sqrt(sum(min(r,0)^2)/T)`, MAR 0. If the denominator is 0: `null`, flag `no-downside`.
- Compounded curve: `C_0 = 1`, `C_i = C_{i-1} * (1 + r_i)`; if `1 + r_i <= 0` set `C_i = 0` for this and all later
  points and add the flag `ruin`.
- `maxDrawdown = max_i (peak_i - C_i) / peak_i` with `peak_i = max(C_0..C_i)`.
- `calmar = (C_last - 1) / maxDrawdown`. If `maxDrawdown == 0`: `null`, flag `no-drawdown`.
- `pnlConsistency`: assign each used interval's `pnl_i - pnl_{i-1}` to the UTC day of `ts_i`
  (`Math.floor(ts_i / 86_400_000)`); a day is positive if its summed PnL is `> 0`;
  `pnlConsistency = positiveDays / daysWithAnyInterval`. **[interpretation]** (README says only "PnL consistency").
- `realizedVol = sqrt(sum(r^2)/T)`.
Every number in `Metrics` is finite or `null`; never `NaN` or `Infinity`.

## Filters (each returns pass / fail / unknown)
- `minAccountValue`: `accountValue >= minAccountValue` (non-finite value: `unknown`).
- `minActiveDays`: from the valid `allTime` history, `activeDays = (lastTs - firstTs)/86_400_000` where `firstTs` is the
  first point with `accountValue > 0` and `lastTs` the last point. `allTime` missing or invalid: `unknown`. No point with
  value > 0: `fail`. Pass if `activeDays >= minActiveDays`. **[interpretation]**
- `minTrades`: `tradeCount === null` -> `unknown`; else pass if `>= minTrades`.
- `notClosed`: `closed === null` -> `unknown`; `false` -> pass; `true` -> fail.
- `minMonthPoints`: month window missing or invalid -> `unknown`; else pass if the number of points `>= minMonthPoints`.

## Eligibility (fail-closed)
`eligible` is true only if every filter is `pass`. With `allowUnknown: true`, `unknown` is treated like `pass`
(still never when any filter is `fail`). The default is `false`. Real data from `ingest` will not have trade counts
until fills are ingested, so demos and fixtures may set `allowUnknown: true`.

## Ranking
Only eligible candidates with non-null metrics are ranked (N of them). Four terms, each "higher is better":
`sortino`, `calmar`, `negMaxDrawdown = -maxDrawdown`, `pnlConsistency`. A `null` value is worse than every non-null
value, and nulls tie with each other.
- Percentile of a value: `N == 1 -> 0.5`; otherwise `(L + (E - 1) / 2) / (N - 1)`, where `L` is the number of values
  strictly worse and `E` the number equal to it (including itself).
- `score` = mean of the four percentiles (equal weights **[interpretation]**, from the README sentence
  "Sortino, Calmar / -max drawdown and PnL consistency").
- Order by `score` descending, ties by `address` ascending (compare lower-cased strings). `rank` is the 1-based
  position. `finalist` is true for the first `config.finalists` candidates in that order.

## Output
`candidates` lists ranked candidates first (by rank), then all others sorted by `address` ascending.
`finalists` is the list of finalist addresses in rank order. Addresses are compared case-insensitively;
two inputs with the same lower-cased address make `scoreCandidates` throw `Error("duplicate address: ...")`.
`funnel` is, in this order: `universe` (all inputs), then after each filter in the order `minAccountValue`,
`minActiveDays`, `minTrades`, `notClosed`, `minMonthPoints` the number of candidates that passed that filter and all
earlier ones (`unknown` counts as passed only with `allowUnknown`), then `eligible` (with non-null metrics),
then `finalists`. Counts never increase along the funnel.
Invalid config (non-integer or `< 1` for `finalists`, `minMonthPoints`; negative or non-finite numbers) throws.

## Code conventions (match `packages/backend`)
TypeScript strict, ESM, extensionless imports, double quotes, semicolons, trailing commas, `const` arrow-function
exports, no `any`, tests with `bun:test` in `test/score/*.test.ts`, comments cite the README section.
Files: `src/score/{types,parse,returns,metrics,filters,score,index}.ts`.

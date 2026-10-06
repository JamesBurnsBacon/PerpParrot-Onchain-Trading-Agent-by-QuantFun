# Score fixtures

Expected values were produced by an independent Python implementation written from `src/score/SPEC.md`
(not by the TypeScript code). Timestamps are milliseconds; `BASE` in the synthetic cases is `20718 * 86400000`,
a UTC day boundary.

- `metrics-cases.json`: small hand-checkable month windows with expected `Metrics` (compare numbers with a
  tolerance of 1e-9; `null` and `flags` must match exactly).
- `portfolio-sample.json`: 24 real Hyperliquid `portfolio` responses (only the `month` and `allTime` windows, values
  as the API returns them: decimal strings) from the public leaderboard, with **addresses replaced by `addr-NN`**.
  `accountValue` is the leaderboard value. `closed` and `tradeCount` are a synthetic overlay: `tradeCount` is 4 for
  `addr-03` and `addr-12`, `null` for every fifth entry, and `40 + n` otherwise. Real trade counts need fills.

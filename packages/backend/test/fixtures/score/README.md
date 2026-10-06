# Score fixtures

Expected values were produced by an independent Python implementation written from `src/score/SPEC.md`
(not by the TypeScript code). Timestamps are milliseconds; `BASE` in the synthetic cases is `20718 * 86400000`,
a UTC day boundary. Numbers are compared with a tolerance of 1e-9; `null`, booleans, strings, `flags` and
ordering must match exactly.

- `metrics-cases.json`: small hand-checkable month windows with expected `Metrics`.
- `portfolio-sample.json`: 24 real Hyperliquid `portfolio` responses (only the `month` and `allTime` windows, values
  as the API returns them: decimal strings) from the public leaderboard, with **addresses replaced by `addr-NN`**.
  `accountValue` is the leaderboard value. `closed` and `tradeCount` are a synthetic overlay: `tradeCount` is 4 for
  `addr-03` and `addr-12`, `null` for every fifth entry, and `40 + n` otherwise. Real trade counts need fills.
- `portfolio-sample.expected.json`: full `scoreCandidates` output for that sample under two configs:
  `strict` (default config) and `permissive` (`{ allowUnknown: true, finalists: 5 }`). Build each `ScoreInput` with
  `address = entry.id`, `kind = "trader"`, and `month`/`allTime` from `parsePortfolio(entry.portfolio)`.
- `edge-cases.json`: one `ScoreInput` per filter boundary and invalid-series case. `expected` has `filters`,
  `eligible`, `metricsIsNull`, `rank`, and the same two fields under `allowUnknown: true`
  (`eligibleWithAllowUnknown`, `rankWithAllowUnknown`). JSON cannot hold `NaN`, so a non-finite `accountValue` is the
  string `"NaN"`; convert it before use.
- `ranking-set.json`: six inputs with `expected` for `scoreCandidates(inputs, { finalists: 3 })` (key `finalists-3`)
  and `scoreCandidates(inputs.slice(0, 1))` (key `single`). It covers ties, null metrics and the address tie-break.

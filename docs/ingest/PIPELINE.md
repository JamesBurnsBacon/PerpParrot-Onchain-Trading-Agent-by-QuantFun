# Ingest → qualify → pick → review → go-live

Owner decisions of 2026-10-07. Code: `packages/backend/src/pipeline/`, cron routes in the root
`vercel.json`, tables in `supabase/migrations/*pipeline*.sql`. Nothing here changes the 10-minute
mirror loop (README §4.7).

## Decisions

- **Scan twice a day** (12-hour cron, 00:15 and 12:15 UTC). Sources, primarily
  hyperliquidvaults.com (vaults) and the Hyperliquid leaderboard (traders), plus a broad scan of
  every leaderboard account and HyperCore vault with ≥ $10k account value or TVL (~13–14k
  accounts).
- **Qualified list of ~250**: once the scan's accounts are refreshed, Score ranks the whole
  population and keeps its top 250 distinct accounts (clones grouped, trader/vault pools
  proportional).
- **Pick 25 every 10 minutes** from the qualified list, with fresh portfolios and fills.
  **High-frequency traders are left out**: more than 100 distinct orders a day in the fills read.
  A 10-minute copy loop can't follow them.
- **Review and automatic go-live**: the AI committee (Role, Risk, Red-Team) reviews the 25. It
  runs only when the 25 changed since the last review.
  A reviewed set that passes the freeze checks becomes the active configuration. It switches only
  when its sources differ from the active set's, so the executor and paper books don't see a new
  configuration hash every 10 minutes. Pause and revert stay with the operator.
- **All on Vercel Cron**, state in Supabase through `DATABASE_URL`. No SQLite, local disk, raw
  archives, receipts, proofs or CRE. Row claims (`for update skip locked`) stop two invocations
  doing the same work. If Hyperliquid rate-limits Vercel's IPs, only the refresh job moves to one
  long-running process (same code with a timer, on Railway).

## Jobs

All are backend routes protected by `CRON_SECRET`. Operators can call them with `ADMIN_TOKEN` as
`POST /admin/pipeline/<step>`.

| Route | Schedule | Work | Writes |
|---|---|---|---|
| `/cron/pipeline/scan` | 00:15, 12:15 UTC | Leaderboard file (~40 MB): ≥ $10k, positive month and all-time PnL. hyperliquidvaults.com's vault list (its TanStack server function), plus Hyperliquid's own vault list (open, not a child, ≥ $10k TVL, ≥ 39 days old). File reads only, no per-account calls. | `pipeline_accounts` (upsert, `listed_at`) |
| `/cron/pipeline/refresh` | every 5 min, ≤ 240 s | First, qualified accounts whose data is over 1 h old: `portfolio` + `userFillsByTime` (30 days, newest 2,000) → trade count, maker share, orders per day. Then accounts not refreshed since the latest scan: `portfolio` only. Keeps only the `month` and `allTime` windows. Unfinished claims are released. | `pipeline_accounts` |
| `/cron/pipeline/select` | every 10 min (`:x4`) | 1. **Qualify** when ≥ 95% of the scan is refreshed and the qualified list is older than the scan: Score the population (trade count may be unknown here) and keep its top 250. 2. **Pick**: Score the qualified accounts with fresh fills, high-frequency traders left out, keep 25. 3. **Review** the 25 if they changed, freeze, and **activate** if the sources changed. | `pipeline_accounts.qualified_at`, `selection_runs`, `configurations` |
| `/cron/pipeline/agent` | every 10 min (`:x8`) | One advisory OpenAI analysis per distinct set of 25; queued inputs plus live core/xyz positions. Unchanged picks reuse the result. Crypto, gold and oil exposure included. | `strategy_analyses` only |

**Hyperliquid budget**: the limit is 1,200 weight per minute per IP. Most info calls cost 20;
fills cost 20 plus 1 per 20 fills; `clearinghouseState` costs 2. The refresh paces itself to 900
per minute, which leaves room for the snapshot cron. Rough load: the population is ~14k × 20
every 12 h (~390/min), and the qualified list is ~250 × ~60 every hour (~250/min). `429` /
`Retry-After` is honoured.

**Cold start**: the first full refresh after a scan takes ~8 h. Until the first qualified list
exists, nothing is picked and the active configuration (or the fixture) stays.

## Review gate

The review core can't pass any candidate yet. `score/frame.ts` and `review/input.ts` leave the
out-of-sample metrics, execution fit and exposure overlap null, and `compile` requires them.
Until measured evidence lands, the **basic gate** (`REVIEW_GATE`, default `basic`) applies: keep
finalists the Role model doesn't reject and with no Risk score above the reject threshold
(evidence risk aside), weight them by Aggressive fit within the per-source cap, cash buffer and
gross leverage, and require ≥ 5 sources. `REVIEW_GATE=strict` turns it off.

## Next

- **Measured evidence** (out-of-sample windows, execution fit, exposure overlap) so the strict
  review can pass candidates. Source: #33's `review/measured-evidence.ts`.
- **Gradual exit** for sources that leave the set (README §4.5: reduce-only legs, then DCA out).
  The first version switches targets directly.
- **Stored month history** per account (denser than `allTime` beyond 30 days; README §4.1).

Advisory strategy notes are integrated separately from the review gate. See
[setup, data scope and queue behavior](../agents/STRATEGY_ANALYSIS.md). They have no
authority over configuration or orders and do not block the review if unavailable.

**Not carried over** from #11, #31, #33 and #38: the SQLite worker and its HTTP server,
receipts, leases and publication endpoints, the CRE workflow, `night-shift-integration/` and its
verifiers, `supabase-js`/Storage archives, the QuickNode bootstrap, the one-time research-cache
import, and runtime dependencies on GitHub Release data. Research tools can live under
`scripts/research/`.

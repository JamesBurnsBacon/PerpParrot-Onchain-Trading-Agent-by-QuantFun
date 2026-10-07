# Ingest → qualify → pick → review → go-live

Owner decisions of 2026-10-07. Code: `packages/backend/src/pipeline/`, cron routes in the root
`vercel.json`, tables in `supabase/migrations/*pipeline*.sql`. Nothing here changes the 10-minute
mirror loop (README §4.7).

## Decisions

- **Scan twice a day** (12-hour cron, 00:15 and 12:15 UTC). Sources, primarily
  hyperliquidvaults.com (vaults) and the Hyperliquid leaderboard (traders), plus a broad scan of
  every leaderboard account and HyperCore vault with ≥ $10k account value or TVL (~13–14k
  accounts).
- **Primary sources**: hyperliquidvaults.com's vaults and the leaderboard's top 200 by month PnL
  hold many of the winners. The data refresh reads them first, and the qualified list waits for
  them.
- **Qualified list of ~250**: Score ranks the scan and keeps its top 250 distinct accounts (clones
  grouped, trader/vault pools proportional). It runs once every primary source is fresh and
  either 95% of the scan is, or 3.5 h after the scan with what is fresh. The 3.5 h case is a cold
  start; when warm, every account is refreshed within 12 h.
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
| `/cron/pipeline/refresh` | every 5 min, ≤ 240 s, 3 reads at a time | First, qualified accounts whose data is over 1 h old: `portfolio` + `userFillsByTime` (30 days, newest 2,000) → trade count, maker share, orders per day. Then the scan's accounts not refreshed for 11 h, primary sources first: `portfolio` only. Keeps only the `month` and `allTime` windows. Unfinished claims are released. | `pipeline_accounts` |
| `/cron/pipeline/select` | every 10 min (`:x4`) | 1. **Qualify** when the qualified list is older than the scan, every primary source is fresh, and ≥ 95% of the scan is (or the scan is 3.5 h old): Score the population (trade count may be unknown here) and keep its top 250. 2. **Pick**: Score the qualified accounts with fresh fills, high-frequency traders left out, keep 25 (with the optional overlap guard, see below). 3. **Review** the 25 if they changed, freeze, and **activate** if the sources changed. | `pipeline_accounts.qualified_at`, `selection_runs`, `configurations` |

**Hyperliquid budget**: the limit is 1,200 weight per minute per IP. Most info calls cost 20;
fills cost 20 plus 1 per 20 fills; `clearinghouseState` costs 2. The refresh paces itself to 900
per minute, which leaves room for the snapshot cron. Rough load: the population is ~14k × 20
every 12 h (~390/min), and the qualified list is ~250 × ~60 every hour (~250/min). `429` /
`Retry-After` is honoured.

**Cold start**: the first full refresh of a scan takes ~6 h, so the first qualified list is built
3.5 h after the scan from what is fresh (~60%, primary sources included). Until a qualified list
exists, nothing is picked and the active configuration (or the fixture) stays.

## Review gate

The review core can't pass any candidate yet. `score/frame.ts` and `review/input.ts` leave the
out-of-sample metrics, execution fit and the frame's exposure overlap null, and `compile` requires them.
Until measured evidence lands, the **basic gate** (`REVIEW_GATE`, default `basic`) applies: keep
finalists the Role model doesn't reject and with no Risk score above the reject threshold
(evidence risk aside), weight them by Aggressive fit within the per-source cap, cash buffer and
gross leverage, and require ≥ 5 sources. `REVIEW_GATE=strict` turns it off.

## Exposure overlap

The overlap of two accounts is the same-direction share of their current books, in [0, 1] (`review/overlap.ts`): each book is the net signed notional per market, summed over dexes and divided by its gross, and the overlap is the sum of the smaller shares over the markets both hold in the same direction. It compares composition only, so two accounts that each hold a single market in the same direction overlap at 1.0 whatever their size or leverage.

- **Measured, always on.** Each review already reads the 25 picks' positions, so it records every pick's largest overlap with another pick under `selection_runs.finalists.overlap` (no extra Hyperliquid reads), and the dashboard shows it as an Overlap column. It does not change the pick, and the frame's `currentExposureOverlap` stays null.
- **Optional guard, off by default.** With `PICK_OVERLAP_GUARD=on` and `NOWNODES_API_KEY`, the pick reads the top 60 candidates' positions NOWNodes first (the official API only as a fallback), leaves out a candidate that overlaps one already chosen by more than the policy's `maxExposureOverlap`, and scores again without it (`pipeline/overlap-pick.ts`). The pick never shrinks, and a failed read or a paused NOWNodes leaves Score's own pick. What it did is recorded under `finalists.overlapGuard`. Env vars and the warning about pick churn: `docs/ops/DEPLOY.md`.

## Next

- **Measured evidence** (out-of-sample windows, execution fit, and the frame's exposure overlap,
  which the picks' overlap above could now fill) so the strict review can pass candidates.
  Source: #33's `review/measured-evidence.ts`.
- **Evidence for the overlap guard**: whether leaving out overlapping candidates helps returns is
  not measured, and it can make the 25 (and so the AI reviews) change more often; a hysteresis
  (keep a current pick unless it overlaps above a looser threshold) is the next step if it does.
- **Gradual exit** for sources that leave the set (README §4.5: reduce-only legs, then DCA out).
  The first version switches targets directly.
- **Stored month history** per account (denser than `allTime` beyond 30 days; README §4.1).
- **Advisory strategy analysis** of the picks (#38's `strategy-agent.ts`): it has no authority
  over configuration or orders.

**Not carried over** from #11, #31, #33 and #38: the SQLite worker and its HTTP server,
receipts, leases and publication endpoints, the CRE workflow, `night-shift-integration/` and its
verifiers, `supabase-js`/Storage archives, the QuickNode bootstrap, the one-time research-cache
import, and runtime dependencies on GitHub Release data. Research tools can live under
`scripts/research/`.

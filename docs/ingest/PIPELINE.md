# Ingest → score → review → go-live (target design)

Decided by the owner on 2026-10-07; **not built yet**. Bradley is reworking #11, #31 and #33 to
this design. Item 5 (go-live) is a separate PR. Nothing here changes the 10-minute mirror loop
(README §4.7).

## Decisions

- **Re-select twice a day**: discover, score and AI review produce a new source set at
  **06:00 and 18:00 UTC**.
- **Automatic go-live**: a set that passes the review and the freeze checks becomes the active
  configuration at the next `:x0` run, with no redeploy and no human step. Pause and revert stay
  available to the operator.
- **All on Vercel Cron**, state in Supabase through `DATABASE_URL` (Bun SQL, like the backend).
  If Hyperliquid rate-limits Vercel's IPs, only the refresh job (2) moves to one long-running
  process. That process uses the same code with a timer instead of a cron, on Railway with the
  existing `packages/backend/Dockerfile`.
- **Simple pipeline**: no SQLite, no local disk, no raw-response archives, no receipts, proofs,
  leases or publication endpoints, and no CRE. A Postgres row claim or advisory lock is enough
  to stop two invocations from doing the same work.

## Jobs

All jobs are backend cron routes protected by `CRON_SECRET`, like `/cron/snapshot`.

| # | Route | Schedule | Work | Writes |
|---|---|---|---|---|
| 1 | `/cron/discover` | daily 00:15 UTC | Leaderboard (~40 MB, 35 s–2 min) and vault list (~14 MB). Keep accounts with ≥ $10k account value or TVL and positive month and all-time PnL; this uses only the files, with no per-account calls. Label HyperCore vaults from the vault list. For ERC-4626 detection (README §4.1), call HyperEVM `eth_getCode` only for addresses not seen before. | `ingest_accounts` (upsert; `last_seen` marks accounts that left) |
| 2 | `/cron/refresh` | every 5 min, ≤ 240 s each | Claim the stalest accounts (`order by refreshed_at nulls first … for update skip locked`). Fetch `portfolio`. For accounts that pass Score's cheap gates, page `userFillsByTime` and keep derived metrics: distinct `(coin, oid)` order count, maker share, hold times. | `ingest_portfolios` (latest per account, overwritten), `ingest_fill_stats` |
| 3 | `/cron/select` | 06:00 and 18:00 UTC | Load `ScoreInput[]` from Postgres (#11's loader), `scoreCandidates` (~8 s, ~0.9 GB for ~11k inputs), then publish the funnel and finalists to the dashboard. | `score_runs`, `dashboard_artifacts` |
| 4 | same invocation as 3 | after 3 | For each finalist, collect measured evidence (`clearinghouseState` + recent fills) and build the review input. Then run the Role, Risk and Red-Team review, which is several minutes of model calls, so this route needs `maxDuration` up to 800 s (the Vercel Pro maximum). | `review_audit` |
| 5 | same invocation as 4 | after 4 | **Go-live**, if the review approved and `freeze.ts`'s checks pass: write the configuration and mark it active. | `configurations` |

**Hyperliquid budget**:
- The limit is 1200 weight/min per IP. Most info calls cost 20; `clearinghouseState` costs 2.
- Ingest keeps itself to ≤ 600 weight/min, which leaves room for the snapshot cron. The budget
  is held in one Postgres row that every invocation reserves from.
- Honour `429` / `Retry-After`.
- At that budget the refresh covers ~11k accounts in about 6 h, so every account is fresh for
  each twice-daily selection.
- On a cold start, `/cron/select` waits until at least 95% of accounts have been refreshed
  within 12 h; it doesn't score on partial data.

**Tables**: the PR proposes the final schema as one migration. #11's migration
(`ingest_runs`, `ingest_candidates`, `ingest_portfolios`, `ingest_sources`) may already have been
applied to production by hand. Check before writing the migration, and alter or replace those
tables rather than adding a parallel set. Store only the
latest portfolio and derived fill metrics per account, not every raw response.

## Go-live (item 5)

- `configurations(hash, configuration jsonb, status, review_id, activated_at)`. Exactly one row
  is `active`.
- The backend reads the active row instead of `CONFIGURATION_PATH`. The executor compares the
  targets' `configurationHash` with the active row instead of `FROZEN_CONFIGURATION_HASH`.
- `HL_ACCOUNT` stays pinned in the environment.
- Guard rails:
  - Aggressive bucket only, enforced already by the review core.
  - The freeze checks run before activation.
  - At most one switch per selection.
  - A switch takes effect at a `:x0` run, never mid-run.
  - `POST /admin/configuration/revert` restores the previous set.
  - `POST /admin/pause` still stops trading.
- The first version switches targets directly: the executor's diff closes what the new set
  doesn't hold. README §4.5's gradual exit for edged-out sources (reduce-only legs, then DCA out)
  is a follow-up.

## PR plan

Keep each PR under about 1,500 changed lines excluding tests. Generated evidence and data files
are never committed. No new CI workflow uses secrets or calls a paid API.

| PR | Contents | Source |
|---|---|---|
| A (first, small) | Model requests use the agent timeout instead of `bounded-http.ts`'s fixed 10 s cap. A journal failure on the executor's last order batch fails the run. Both with tests. | #33 |
| B | Ingest tables, `/cron/discover`, `/cron/refresh`, the Postgres-held budget | #11 discovery, classification and order counting; #31 `BudgetClient` and fetch logic, ported from SQLite to Postgres |
| C | `/cron/select` scoring from Postgres, `score_runs`, dashboard funnel | #11 Score loader |
| D | Measured evidence and the scheduled review | #33 `review/measured-evidence.ts` |
| E | Go-live (above) | new |

**Not carried over**:
- The SQLite worker and its HTTP server, receipts, lease and publication endpoints.
- The CRE `ingest-cycle` workflow.
- The 10-minute Top 100 loop: nothing consumes it while the active set changes twice a day.
- `night-shift-integration/` and its evidence, verifiers and rule adapters.
- `supabase-js`, `SUPABASE_SECRET_KEY` and Storage archives: use `DATABASE_URL`.
- The QuickNode-only bootstrap.
- Runtime dependencies on GitHub Release data.

Research, replay and export tools can live under `scripts/research/` if still wanted, not in
`packages/backend/src`.

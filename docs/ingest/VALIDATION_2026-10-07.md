# Ingest integration validation — 2026-10-07

Recorded at 03:21 UTC (11:21 UTC+8). Base: `7f7bf5c`.
This report contains aggregate results only; private snapshots, raw trades, model keys and unredacted logs are not included.

| Check | Observed result | Boundary |
| --- | --- | --- |
| Backend `bun test` + `bun run typecheck` | 399 pass, 1 skipped, no failures; typecheck passed | Real PostgreSQL test needs `TEST_DATABASE_URL`; local SQL tests used PGlite |
| Root `pnpm typecheck` + `pnpm test` | Typecheck and 11 test files passed | Review contracts/behavior, no paid provider |
| Executor `bun test` + TypeScript | 74 pass, 1 skipped; typecheck passed | Real PostgreSQL lock test needs `TEST_DATABASE_URL` |
| Dashboard `bun run build --webpack` | Build and static generation passed | Default Turbopack build hit an environment port-binding restriction; CI must check the standard build |
| `scripts/e2e-mirror.sh all` | All 5 scenarios passed: normal, paused, backend down, configuration mismatch, duplicate | Live Hyperliquid reads, fixture configuration, local memory store, dry run; no orders sent |
| Initial-cache `--check-only` | 10,987 rows validated; 98 vaults (including ERC-4626); zero source API calls | Read-only SQLite snapshot, not imported into cloud Postgres |
| Initial order proof | 5,632 rows establish ≥10 distinct observed perp orders from preserved blobs | Lower bound only; spot orders excluded, missing evidence remains unknown |

The SQL/HTTP integration test starts with 205 synthetic sources including both vaults and traders, uses the real teammate Score implementation,
refreshes 200 portfolios, selects 25, collects 50 current DEX states and validates/persists a mocked Agent analysis.
Both source types are asserted in the refreshed cohort and finalist set. This proves interface integration, not investment performance or a real model run.

Additional tests verify that scheduled portfolio refreshes **never request fills even when initial evidence is missing**;
old order-count proof survives refresh without making old maker-share evidence current; cache import is idempotent and cannot overwrite newer portfolios;
priority preemption fences the previous writer; minute budgets, duplicate triggers, timestamps and legacy-table preservation are enforced.

Cloud status remains unverified: no new migration or production cron cutover, no paid OpenAI/Anthropic batch, and no measured production 12-hour coverage.
Vercel console login was required, so `DATABASE_URL` presence could not be confirmed. The legacy local collector and research files were retained.
Deployment/import/recovery steps: [POSTGRES_RUNBOOK.md](POSTGRES_RUNBOOK.md).

## Ten-minute live rehearsal and follow-up

Run: **03:30:24–03:40:24 UTC**, 600.003 seconds, at commit `4230cc5`.
[Machine-readable aggregate evidence](evidence/ten-minute-rehearsal-20261007.json) includes hashes of the retained local artifacts.
No account lists, raw responses, positions or unredacted logs are checked in here.

| Observation | Result |
| --- | --- |
| Priority cohort | 200/200 refreshed in 182.290 seconds; 196 traders, 4 vaults |
| Further refreshes | 394 successful; 1 cached source lacked classification; 4 budget waits cancelled before HTTP at the deadline |
| Score finalists | 24 traders + 1 vault; all eight gates pass; pool percentiles and weighted scores independently recomputed |
| Input/replay check | All 200 inputs match saved API portfolios; production Score replay reproduces the complete result |
| Current position evidence | 50 core/xyz state queries; 6 finalists had nonzero positions, 19 did not; 97 position rows total |
| Source HTTP | 595 portfolio + 50 state requests; all 645 returned 200; zero 429s; no fill-history requests |
| Budget finding | 12,000 total weight; one 60-second dispatch window reached **1,220 for a 1 ms overlap**; strict rolling-limit check **failed** |
| Economic actions | No model call, production publication, configuration activation or exchange order |

The preserved 10,987-source cache had only 1,661 fresh valid sources at start. This rehearsal deliberately used a preview-only
cache preselection, then real refreshes and the existing Score on the 200-source cohort. It did not publish through the production
95% global-freshness gate or demonstrate global-current Top 25, a complete 12-hour cycle, or trading profitability.
The temporary replay driver rejected an unclassified source; the production worker already resolves unknown classification before fetching its portfolio.
A regression test now exercises that path and confirms it does not request fills.

The follow-up limiter change retains grants through a one-second dispatch lease in addition to the full rolling minute.
The client refuses to dispatch a grant that has already consumed that lease, measured before the SQL round trip.
Regression tests cover the minute boundary and a delayed grant; the original live result above remains a failure, not evidence of the fix.
No second live ten-minute run or hosted PostgreSQL concurrency test has been performed for this follow-up.

Follow-up checks: backend `bun test` **402 passed, 1 real-PostgreSQL test skipped, 0 failures**;
`bun run typecheck` passed. The three new regressions cover delayed-dispatch accounting, expired permits,
and the existing missing-classification recovery path. This follow-up does not change cron schedules,
cohort/finalist counts, the Score formula, Review policy or execution settings.

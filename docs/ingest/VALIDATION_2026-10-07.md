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

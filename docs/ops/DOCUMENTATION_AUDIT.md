# Documentation audit — 2026-10-07

Repository baseline: `7e42eae` (main including Parrot confirmation saving feedback).
This audit covers tracked explanatory text and environment examples, plus stale schedule
comments in the executor and predeploy checker. Source, tests, schemas and `vercel.json`
were used to resolve contradictions. It is not a new production deployment attestation.

## Corrections

- NOWNodes supported-read routing, official fallback, independent-provider verification
  limits, rollback and measured latency scope.
- Supabase active configuration versus bootstrap pins; backend cron versus the
  long-running executor timer; isolated deployment rehearsals and data preservation.
- Implemented bench/roster lifecycle, fixed source weights, counted gross, current
  Score formula, clone grouping, maker-share input and missing daily history archive.
- Strict-core versus basic-gate versus paper-library boundaries; Parrot plan/save routes,
  confirmation feedback, and read-only card behavior.
- Historical API/provider research moved from the product README to
  [dated observations](../research/OBSERVATIONS_20261006.md). Historical captures,
  source hashes and numerical findings remain historical; absent raw captures remain disclosed.

## Traversal inventory

43 tracked explanatory/configuration files reviewed. Unchanged entries were checked, not rewritten just to change their dates. Binary pitch assets, lockfiles, historical source fixtures, untracked research, backups and secret env files are preserved.

| File | Result | Scope |
| --- | --- | --- |
| `.env.example` | Updated | Current implementation / operator reference |
| `.github/workflows/agent-review-checks.yaml` | Reviewed; unchanged | CI configuration; current checks retained |
| `.github/workflows/service-checks.yml` | Reviewed; unchanged | CI configuration; current checks retained |
| `AGENTS.md` | Updated | Current implementation / operator reference |
| `CLAUDE.md` | Reviewed; unchanged | Agent pointer/generated framework guidance; retained |
| `README.md` | Updated | Current implementation / operator reference |
| `docs/PARROT.md` | Updated | Current implementation / operator reference |
| `docs/README.md` | Updated | Current implementation / operator reference |
| `docs/WALLET-BOARD-VERIFICATION.md` | Reviewed; unchanged | Dated evidence; preserve measurements, qualify scope |
| `docs/agents/ARCHITECTURE.md` | Updated | Current implementation / operator reference |
| `docs/agents/BASIC_GATE_FALLBACK.md` | Updated | Current implementation / operator reference |
| `docs/agents/EVALUATION.md` | Updated | Current implementation / operator reference |
| `docs/agents/FEATURE_DISCOVERY.md` | Updated | Dated evidence; preserve measurements, qualify scope |
| `docs/agents/GBRAIN_CONTEXT.md` | Updated | Current implementation / operator reference |
| `docs/agents/INTEGRATION.md` | Updated | Current implementation / operator reference |
| `docs/agents/PAPER_LIFECYCLE.md` | Updated | Current implementation / operator reference |
| `docs/agents/PRESSURE_TEST.md` | Updated | Dated evidence; preserve measurements, qualify scope |
| `docs/agents/PRODUCTION_INTEGRATION.md` | Updated | Current implementation / operator reference |
| `docs/agents/REAL_DATA_BACKTEST.md` | Updated | Dated evidence; preserve measurements, qualify scope |
| `docs/agents/SCORING_EVALUATION.md` | Updated | Current implementation / operator reference |
| `docs/agents/STRATEGY_INTENT.md` | Updated | Current implementation / operator reference |
| `docs/agents/SYSTEM_PROMPTS.md` | Reviewed; unchanged | Runtime prompt contract; preserve text and test equality |
| `docs/ingest/CHURN.md` | Updated | Dated evidence; preserve measurements, qualify scope |
| `docs/ingest/PIPELINE.md` | Updated | Current implementation / operator reference |
| `docs/ingest/RESEARCH_SCREENING_V1.md` | Reviewed; unchanged | Dated evidence; preserve measurements, qualify scope |
| `docs/ingest/ROSTER.md` | Updated | Current implementation / operator reference |
| `docs/ingest/examples/research-screen-v1.ts.txt` | Reviewed; unchanged | Hashed historical source fixture; preserve bytes |
| `docs/ops/DEPLOY.md` | Updated | Current implementation / operator reference |
| `docs/ops/RUNBOOK.md` | Updated | Current implementation / operator reference |
| `docs/parrot/DEMO.md` | Updated | Current implementation / operator reference |
| `docs/parrot/INTEGRATION.md` | Updated | Current implementation / operator reference |
| `docs/parrot/README.md` | Updated | Current implementation / operator reference |
| `docs/pitch/mirror-inspired/PerpParrot-Mirror-Inspired-Speech.md` | Updated | Dated evidence; preserve measurements, qualify scope |
| `docs/pitch/mirror-inspired/README.md` | Reviewed; unchanged | Dated evidence; preserve measurements, qualify scope |
| `packages/backend/src/live/README.md` | Updated | Current implementation / operator reference |
| `packages/backend/src/score/SPEC.md` | Updated | Current implementation / operator reference |
| `packages/backend/test/fixtures/score/README.md` | Reviewed; unchanged | Fixture provenance and regeneration instructions; retained |
| `packages/dashboard/.env.example` | Reviewed; unchanged | Current implementation / operator reference |
| `packages/dashboard/AGENTS.md` | Reviewed; unchanged | Agent pointer/generated framework guidance; retained |
| `packages/dashboard/CLAUDE.md` | Reviewed; unchanged | Agent pointer/generated framework guidance; retained |
| `packages/dashboard/app/opengraph-image.alt.txt` | Reviewed; unchanged | Verified against the actual image; matches |
| `packages/executor/.env.example` | Updated | Current implementation / operator reference |
| `scripts/research/maker-share/README.md` | Updated | Dated evidence; preserve measurements, qualify scope |

## Validation

Local checks after the documentation sweep, with Node 24 / Bun 1.4.2:

- Root typecheck and 11 test files passed; 34 JSON contract checks passed.
- Backend: 871 passed, 23 database-dependent skips; typecheck passed.
- Executor: 98 passed, 3 database-dependent skips; typecheck passed.
- Dashboard: 227 passed; default production build passed on Linux.
- Markdown local file links/heading anchors and `git diff --check` passed.
- The earlier cleanup E2E used live public Hyperliquid reads and dry-run execution:
  five cases passed (normal, paused, unavailable backend, wrong hash, duplicate run),
  177 orders planned, zero submitted. This sweep changes no runtime behavior.

Database tests skipped locally are exercised by the existing PostgreSQL CI jobs;
check the final PR revision's status before merge. Model quality, real microphone
acceptance, production activation and funded fills are separate evidence boundaries.

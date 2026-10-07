# Documentation map

## Current product and operations

- [Product overview](../README.md): architecture and implementation boundaries.
- [Ingest and review pipeline](ingest/PIPELINE.md), then [roster](ingest/ROSTER.md):
  scan → qualify → pick → review → bench → seats → active frozen configuration.
- [Integration map](agents/PRODUCTION_INTEGRATION.md) and
  [review-core contract](agents/INTEGRATION.md): runtime wiring versus library contracts.
- [Runbook](ops/RUNBOOK.md) and [deployment](ops/DEPLOY.md): snapshot → targets → executor
  → persisted runs → dashboard; NOWNodes routing and recovery switches.
- [Parrot](parrot/README.md): product UI, chat and its authorization boundaries.

The package source, tests, migrations and root `vercel.json` determine actual
behavior. A document or local test does not attest to a deployment's current state.

## Research and historical evidence

These explain experiments and decisions; they are not production entrypoints or
proof of investment performance. Keep negative results and their limitations.

- [Scoring evaluation](agents/SCORING_EVALUATION.md): current formula and evaluation gates.
- [October 6 backtest](agents/REAL_DATA_BACKTEST.md) and
  [feature exploration](agents/FEATURE_DISCOVERY.md): dated research whose raw captures
  are local-only under ignored `work/backtests/`; not independently reproducible from
  a fresh clone without those captures.
- [October 6 research screening](ingest/RESEARCH_SCREENING_V1.md) and its examples:
  reference snapshots, separate from the production pipeline.
- [Maker-share study](../scripts/research/maker-share/README.md): supporting research.
- [Historical pressure test](agents/PRESSURE_TEST.md): original review-core findings;
  its test counts and open items describe that contribution, not today's deployment.
- [Dated jury pitch](pitch/mirror-inspired/README.md): presentation assets with an
  explicit code baseline and screenshot times.

## Development-only tools

`packages/dashboard/app/parrot/lab/` and `EffectsLab.tsx` are development UI tools,
protected from production use. Tests, fixtures, migrations and per-package lockfiles
support the maintained services and are not disposable duplicates.

Untracked local worktrees, backups and `.env` files are outside the published mainline.
Do not publish local research captures or credentials while tidying the repository.

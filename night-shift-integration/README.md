# Night handoff: ordinary services, one inspectable pipeline

Downloadable evidence is also checked into [evidence/](evidence/); its verifier recomputes the full chain.

Start with **[HANDOFF_CN.md](HANDOFF_CN.md)** (Chinese), **[FOLLOWUP_REPORT.md](FOLLOWUP_REPORT.md)** (latest results), **[INTERFACES.md](INTERFACES.md)** (replaceable contracts), and **[DELIVERY_REPORT.md](DELIVERY_REPORT.md)** (initial evidence). [TEAM_SYNC.md](TEAM_SYNC.md) records the teammate revisions used.

Based on James's PR #32, `af7e857`: no Chainlink dependency. Reuses Masa's current Score, the team's Review/audit/freeze modules, backend snapshots, target exposure math, executor and SQL stores. Two tiny deterministic rule adapters are deliberately unchanged: A ranks positive trailing return; B ranks lower sampled drawdown. They are not two LLMs.

## Five-minute offline demonstration

Node 24+, pnpm 11.25.0 and Bun 1.4.2. No credentials, external API, paid model or exchange connection is needed for this command.

```sh
pnpm install --frozen-lockfile
(cd packages/backend && bun --no-env-file install --frozen-lockfile)
(cd packages/executor && bun --no-env-file install --frozen-lockfile)
./node_modules/.bin/tsc -p night-shift-integration/tsconfig.json
bun --no-env-file test night-shift-integration/
bun --no-env-file night-shift-integration/demo.ts
```

Open `night-shift-integration/out/demo/demo.html`. Its adjacent `evidence.json` includes commitments, assertions and the final receipt. The controlled data is explicitly synthetic; the team modules and database migrations really run:

```text
Score → review input → Role / Risk / Red-Team → audit
  → frozen configuration → database reopen → monitoring-only
  → source positions → backend snapshot → HTTP targets
  → executor dry run → persisted run → dashboard read
```

Repeat the command: both committed stages are reused. To demonstrate restart recovery:

```sh
# Expected exit 1 after the first committed stage.
bun --no-env-file night-shift-integration/demo.ts --out night-shift-integration/out/recovery-demo --fail-after return-first
# Resume: first stage reused, second completed.
bun --no-env-file night-shift-integration/demo.ts --out night-shift-integration/out/recovery-demo
```

Tests separately SIGKILL a child after a committed checkpoint. The framework is single-host SQLite; executor deduplication and action journaling use the actual SQL store interfaces. See the service proof for the tested database adapter and limits. CI runs this demo without secrets and uploads HTML + JSON.

## Real data, separate evidence

1. **Top 100 ingestion:** the ordinary backend job imports the existing registry without changing its source, re-ranks using current Score and fetches official-API portfolios. See [ingest handoff](../docs/ingest/NIGHT_HANDOFF_INGEST.md). This job is distinct from the frozen sources' positions mirror.
2. **Historical evaluation:** the existing 10,934-input archive is validated and replayed over 14 / 30 / 42 / 90-day windows with A, B and BTC. The research universe was selected retrospectively, so this is an integration baseline with survivorship bias, not a point-in-time strategy validation.
3. **Live-data service smoke:** `scripts/e2e-mirror.sh all` starts actual backend/executor processes and uses public Hyperliquid reads. It stays dry-run. Its checked-in fixture configuration is independent of the synthetic Review demonstration.

The measured rehearsal additionally feeds 25 strict Score finalists from one real Top 100 artifact through Review and SQL audit. See [MEASURED_PIPELINE.md](MEASURED_PIPELINE.md) for units and contracts, and the latest report for actual acceptance/rejection and provider results. The complete Review-to-executor success scenario uses explicitly controlled inputs; the real cohort must satisfy the existing gates to freeze.

For full historical replay, download the existing published archive:

```sh
gh release download score-data-2026-10-06 \
  --repo JamesBurnsBacon/PerpParrot-Onchain-Trading-Agent-by-QuantFun \
  --pattern manifest.json --pattern score-inputs.jsonl.gz --dir ./local-score-data
bun --no-env-file night-shift-integration/fetch-benchmark.ts --data ./local-score-data
bun --no-env-file night-shift-integration/run.ts --data ./local-score-data --ticks 2
```

The benchmark command caches one public API response. The replay then works offline. `--ticks 2` advances a logical clock by ten minutes; it does not manufacture fresh collection timestamps. The default archive directory is `./local-score-data`; use `--data` for another location.

## What to replace tomorrow

- A/B rule logic: `algorithms.ts::allocate`; keep `night-allocation.v1`, fractional weights and deterministic ties.
- Model adapters: keep the existing OpenAI-compatible adapter, evidence hashes, schemas, timeouts and audit; use provider receipts to distinguish actual calls from rule adapters.
- Measured fields: `measured-evidence.ts` supplies raw-bound measurements and explicit coverage; use candidate diagnostics to prioritize remaining gaps.
- Runtime: invoke the ordinary ingestion job from one supervised worker; use Vercel Cron only if runtime fits. Frozen mirror runs use James's backend/executor cron interfaces.
- Database: apply the reviewed migrations to the intended environment before deploying renamed tables. Local PGlite proof does not apply them to Supabase.

Existing live ingestion remains on its original branch. This delivery does not change the real frozen configuration or send exchange orders. Hosted runtime verification and any funded canary remain operator work; the latest report records model-call outcomes separately.

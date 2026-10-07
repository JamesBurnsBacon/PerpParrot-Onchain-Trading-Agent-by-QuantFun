# Integrating Parrot

[Overview](README.md) · [Presenter guide](DEMO.md) · [Technical reference and file map](../PARROT.md#file-map)

## Read-only seams

Paths are repository-relative. Wiring: [`server.ts`](../../packages/backend/src/server.ts); storage: [`pg-store.ts`](../../packages/backend/src/pg-store.ts).

| Existing source | Parrot reader and result |
| --- | --- |
| `pipeline_accounts`: `address`, `kind`, `account_value`, `closed`, `portfolio`, `trade_count`, `maker_share`; filter uses `listed_at` | `parrotFinalists` → `createFinalistsSource` → `parsePortfolio` / unchanged `scoreCandidates` → `mapScoreFinalists`; display adds rank, period return and finite Sharpe |
| Shared `StrategyIntent` and `shortlist` | `parseStrategyIntent` validates; `selectStrategy` / `explainSelection` project choices and facts. See [the seven variables](../PARROT.md#visitor-preferences-and-available-facts); Parrot never calls `intentToPreview` |
| `configurations.configuration` where `status = 'active'` | `ActiveConfigurationSource.load`, falling back to `FileConfigurationSource`; `loadChatDeps` validates and caches `basePolicy` after success; `readActiveSources` reloads `sources[].sourceAddress` for comparison |
| `paper_points` (`book_id`, `t`, `equity_usd`) | `readPaperPoints` → `paperStore.points` → `buildLiveContext`; existing book replay, never the new shortlist's performance |
| `paper_state.state`, `run_snapshots.body` | `readLiveExposures` → `readLiveBookExposures` → `paper.view().lastRunAt` → `store.get` → `exposuresFromSnapshot`; stored target exposures, not newly measured positions |
| `dashboard_artifacts.body` (`name = 'funnel'`) and paper service | `useVerification` reads `/artifacts/funnel` and `/paper`; cached demos provide no verification evidence |

These reads cannot change pipeline state. Parrot writes only `chat_usage` reservations/settlements and `strategy_requests` through `PostgresRequestStore.save` (SQL status `pending`; UI PENDING). `buildPreview` produces equal simulation weights under the base policy. [Cache windows, fallback thresholds and context deadlines](../PARROT.md#data-caches-and-fallbacks) remain in the reference.

## Invariants and ownership

- No orders, signing keys, administrative credentials, execution endpoints or freeze operations in Parrot. Preserve `packages/backend/test/parrot-no-authority.test.ts`.
- Every saved preview has `approvalRequired: true`; the base policy changes only to `mode: "SIMULATION"`. Requested leverage is context only. Infeasible allocations fail; never increase the visitor's source limit or rewrite policy to make them fit.
- Model prose, visitor input and retrieved context are untrusted data. Code owns selection, facts and preview allocations; receipt verdicts never feed back into Live, selection or execution.
- The server owns prompts, models, tools and delegation. Preserve the browser event allowlist in `live/config.ts`, response guards, rate limits, reservations, shared budget, media teardown and speech suppression of effects.
- Preserve development-only imports and the `/parrot/lab` tracing exclusion in `packages/dashboard/next.config.ts`. Do not reintroduce Chainlink CRE or its removed infrastructure.

Read root `AGENTS.md` and `packages/dashboard/AGENTS.md`. Preserve persona text, sound mapping and HTTP shapes in cleanups; add no dependencies.

Other workstreams own these files; read, but do not edit for a Parrot cleanup:

| Boundary | Files |
| --- | --- |
| Shared strategy contract | `packages/shared/strategy-intent.ts`, `packages/backend/src/strategy-intent-adapter.ts`, `packages/backend/test/strategy-intent.test.ts` |
| Review and pipeline | `packages/backend/scripts/review-input.ts`, `packages/backend/src/pipeline/*`, `packages/backend/src/paper/*`, `packages/backend/src/score/*` |
| Execution and infrastructure | `packages/executor/**`, `.github/workflows/*`, root `AGENTS.md`, root `README.md`, `vercel.json` |

## Extension recipes

| Change | Steps and verification |
| --- | --- |
| Add a context fact | Add a named read-only dependency in `server.ts` and `LiveContextDeps` in `packages/backend/src/live/context.ts`. Summarize through its independent failure/deadline boundary; omit unavailable data. Extend `packages/shared/live-context.ts`, dashboard `lib/parrot-context.ts` guards/summary and relevant response tests together. Keep `appendContextFacts` bounded and the safety statement intact; never put context into intent or preview. Run the context mutation check in [Verify offline](../PARROT.md#verify-offline) |
| Add a sound | Audition a development recipe in dashboard `lib/parrot-sfx-catalog.ts` / `/parrot/lab` first. For a product cue, extend `SfxCue` and `scheduleSfx` in `lib/wallet-board.ts`, then `ParrotSfx` in `lib/parrot-sfx.ts`. Preserve gesture unlock, speech/mute checks, timer/source cleanup and reduced-motion behavior; verify scheduler and mocked audio tests, then listen in a real browser. Production compact receipts stay silent |
| Add a verdict stamp | For presentation wording, update dashboard `lib/parrot-receipts.ts` (`STAMPS`, `CAPTIONS`) and test standalone, live-feed and compact renders. Keep `settle` disagreement handling and banter unchanged. A fifth result requires contract review: shared `receipt.ts` (`RELATIONS`, fixed questions, parser/guards), cached fixtures, CSS and all receipt consumers/tests together; never relabel a model opinion as truth |

## Switch from sample to stored live data

There is no “force live” switch. The pipeline operator prepares the database and ingestion using the [deploy guide](../ops/DEPLOY.md#selection-pipeline). Set backend `BACKEND_DATABASE_URL` or `DATABASE_URL`; the existing reader selects live finalists automatically when the [pool requirements](../PARROT.md#data-caches-and-fallbacks) pass. Wait for its cache to expire, then inspect `shortlist.dataSource === "live"` and the stored listing/portfolio freshness. The listing filter is relative to the latest stored listing, not wall-clock freshness.

Check book context independently of shortlist source. Never relabel fixtures, manufacture paper history or change Score thresholds. The standalone `/parrot/receipts` receipt intentionally stays sample; `/parrot/receipts/live` uses the current turn's code-built facts. A caller-supplied receipt does not attest its provenance.

## Voice confirmation routes

| Route | What it does | Writes |
| --- | --- | --- |
| `POST /live/plan` `{intent}` | Selects the shortlist from the current finalists, builds the preview, then a hypothetical dry-run order sketch from public Hyperliquid reads (`packages/backend/src/live/plan.ts`, about 25 reads, cached 60 s per preview hash). Returns `{previewHash, sources, plan}`. | Nothing |
| `POST /live/request` `{intent, previewHash}` | Saves one PENDING simulation request through the same `savePreviewRequest` as `/chat/preview`; refuses with 409 `changed` if the preview hash is no longer the one the visitor was shown. | One `strategy_requests` row |

Both are gated by `LIVE_ENABLED` and use the `preview` limiter kind (zero cost). The tools `request_confirmation` and `confirm_request` are defined in `packages/backend/src/live/config.ts`; the browser-side gate (nonce, window, transcript check, button) is `packages/dashboard/lib/parrot-confirm.ts`. The dry-run sketch signs and sends nothing and imports no executor code. Shared type: `packages/shared/dry-run-plan.ts`.

## Local testing with real wallets (no database, no production writes)

To see real wallet metrics instead of the labelled sample without touching the production database, score a local file of real accounts:

1. `cd packages/backend && bun run scripts/fetch-local-finalists.ts --out /tmp/finalists.json` reads Hyperliquid's public leaderboard and portfolios (read-only) plus the production pipeline's current finalists (one public `GET /pipeline`) and writes the rows.
2. Start the local backend with `PARROT_FINALISTS_FILE=/tmp/finalists.json` and no `DATABASE_URL`. The existing Score code then picks finalists from that pool and the page shows no SAMPLE DATA badge.

The pool is smaller than production's (about 85 accounts against about 250 qualified), so finalists can differ from production's. The variable is ignored when a database is configured or `VERCEL` is set, so a deployed backend cannot use it. Never point a local backend at the production `DATABASE_URL`: outside Vercel it builds snapshots and steps the paper books on a timer.

## Environment and Vercel ownership

**Operator** means the Vercel project operator with team access: set server variables in the intended environment and redeploy. GitHub Actions secrets do not populate Vercel. Never expose keys in browser variables. Defaults: [`server.ts`](../../packages/backend/src/server.ts), [`readLiveEnv`](../../packages/backend/src/live/config.ts) and [`readDecisionsEnv`](../../packages/backend/src/live/decisions.ts).

| Variable | Default / purpose | Who sets it on Vercel |
| --- | --- | --- |
| `OPENAI_API_KEY` | Unset; server-only provider calls | Operator; required for model calls |
| `CHAT_ENABLED` | Off; literal `true` enables text and pending saves | Operator |
| `LIVE_ENABLED` | Off; literal `true` enables Live | Operator; demo window only |
| `DECISIONS_ENABLED` | Off; literal `true` enables receipts, independently | Operator |
| `CHAT_MODEL` | `gpt-5.4-mini` | Operator (override) |
| `CHAT_IP_SALT` | `perpparrot-chat-v1`; limiter IP hashing | Operator (override) |
| `CHAT_DAILY_BUDGET_USD` | `5`; shared Chat / Live / Decisions reservation budget | Operator |
| `CHAT_IP_HOURLY_LIMIT` / `CHAT_GLOBAL_DAILY_LIMIT` | `10` / `100` calls | Operator (override) |
| `CHAT_PREVIEW_IP_HOURLY_LIMIT` / `CHAT_PREVIEW_GLOBAL_DAILY_LIMIT` | `30` / `500`; also covers `/live/strategy` | Operator (override) |
| `CHAT_PRICE_IN_PER_M_USD` / `CHAT_PRICE_OUT_PER_M_USD` | `1` / `4`; estimates per million tokens | Operator (override) |
| `LIVE_MODEL` / `LIVE_BACKEND_MODEL` | `gpt-live-1` / `gpt-5.6-terra` | Operator (override) |
| `LIVE_VOICE` / `LIVE_BACKEND_REASONING` | `gleam` / `medium` | Operator (override) |
| `LIVE_MAX_SESSION_SECONDS` | `180`; integer 1–900; browser countdown only | Operator (override) |
| `LIVE_IP_HOURLY_LIMIT` / `LIVE_GLOBAL_DAILY_LIMIT` | `3` / `30` sessions | Operator (override) |
| `LIVE_VOICE_PRICE_PER_MIN_USD` / `LIVE_BACKEND_ALLOWANCE_USD` | `0.05` / `0.15`; minute estimate / session allowance | Operator (override) |
| `DECISIONS_MODEL` | `gpt-6-luna` | Operator (override) |
| `DECISIONS_PRICE_PER_M_USD` | `0.10`; estimated input-only cost per million tokens | Operator (override) |
| `DECISIONS_IP_HOURLY_LIMIT` / `DECISIONS_GLOBAL_DAILY_LIMIT` | `240` / `3000` calls | Operator (override) |
| `DATABASE_URL` (or backend-only `BACKEND_DATABASE_URL`) / `CRON_SECRET` | Unset; a database connection and cron secret are required on Vercel | Shared-service operator; [runbook](../ops/RUNBOOK.md) |
| `CONFIGURATION_PATH` / `FROZEN_CONFIGURATION_HASH` | No defaults; required configuration file and pin | Shared-service operator; [deployment](../ops/DEPLOY.md) |

Invalid optional numeric Parrot settings fall back to defaults. Reservations are estimates, not provider billing caps; session/backend cost and IP trust limits are in [Residual risks](../PARROT.md#residual-risks-and-unverified-items).

## Migrations and local setup

Apply shared-service migrations using the [runbook](../ops/RUNBOOK.md), without resetting the database. The Parrot-specific dependency order under `supabase/migrations/` is:

| Order | Migration | Effect |
| --- | --- | --- |
| 1 | `20261006140000_chat.sql` | Creates `chat_usage`, `strategy_requests`, service-role access and RLS |
| 2 | `20261007000000_live_usage.sql` | Allows `live` usage reservations |
| 3 | `20261008000000_decisions_usage.sql` | Allows `decide` usage reservations; apply before enabling Decisions |

Live sources also require (`20261007120000_pipeline.sql`) and the snapshot/table upgrade described in the deploy guide. Follow the full shared migration order. Without a database, local request/limiter stores are in-memory and not durable or cross-instance.

For an in-memory local rehearsal, unset both `DATABASE_URL` and `BACKEND_DATABASE_URL` and avoid loading a production `.env`. From `packages/backend`, using a locally supplied secret (never commit its value):

```sh
CONFIGURATION_PATH=fixtures/frozen-configuration.json \
FROZEN_CONFIGURATION_HASH=<configurationHash from that file> \
CHAT_ENABLED=true LIVE_ENABLED=true DECISIONS_ENABLED=true OPENAI_API_KEY=<local secret> \
PORT=8788 bun run src/server.ts
```

From `packages/dashboard`, run `bun run dev` and open `http://localhost:3000/parrot`; the development rewrite targets backend port 8788. For offline inspection use cached examples or labs. Endpoint payloads remain in the [technical reference](../PARROT.md#endpoints-and-configuration).

## Pre-merge / pre-deploy checklist

- [ ] Review the diff against the ownership/invariant boundaries; no secrets or private account/trade data in docs or fixtures.
- [ ] Run both packages' tests/type checks, dashboard default build and production marker scan in [Verify offline](../PARROT.md#verify-offline). Dashboard minimum: `cd packages/dashboard && bun test && bunx --no-install tsc --noEmit`. Run relevant mutation scripts for selection, context, scheduler or receipt changes.
- [ ] Check Markdown paths/anchors and all references before moving content. Record checks as local evidence, separately from CI and deployment.
- [ ] Operator confirms migrations, Vercel variables, ingress IP-header handling and provider spend controls; their deployed state is not verified here.
- [ ] Rehearse [DEMO.md](DEMO.md), including fallback labels, End/Mute and a real microphone; the historical provider checks used typed turns only.
- [ ] Check deployed routes, actual data source and production lab exclusion. Keep executor dry-run behavior intact; Parrot deployment grants no trading authority.

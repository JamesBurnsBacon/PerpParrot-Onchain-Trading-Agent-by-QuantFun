# Parrot: wallet exploration over the existing pipeline

`/parrot` is a voice-first wallet explorer with an optional text-chat path. It is **an extra view over the existing pipeline**: it reuses tracked Hyperliquid accounts, Score, the shared shortlist contract and read-only book evidence. The Parrot adds presentation—nicknames, bird tiles and explanations—and can save a pending simulation request. It sits outside the ten-minute execution loop and has no trading authority.

```text
Existing pipeline on our infrastructure:
Hyperliquid → Score → AI review (Role / Risk / Red-Team) → frozen configuration
                                                             ↓
                      snapshots + target exposures → executor → recorded runs / paper books
                             │                            (separate authority)
                             └──────── read-only evidence ──────────┐
Score finalists + active configuration ─────────────────────────────┤
                                                                   ↓
Visitor → WebRTC GPT-Live → delegated backend model → set_strategy → Parrot
          gpt-live-1        gpt-5.6-terra                │            ↓
                                               POST /live/strategy  shortlist + facts
Visitor → hold to confirm → POST /chat/preview → PENDING simulation request
                                                 ↓
                                     separate operator review and freeze
```

Architecture and operations: [README §§4.7, 4.8, 4.14](../README.md), [runbook](ops/RUNBOOK.md), [deployment](ops/DEPLOY.md), [AI review integration](agents/INTEGRATION.md), [verified integration status](agents/PRODUCTION_INTEGRATION.md). Chainlink CRE and its DON are removed; do not reintroduce that architecture.

## Invariants

1. **No trading authority.** No orders, signing keys, administrative credentials, execution endpoints or configuration freeze operations belong in Parrot code. Keep `parrot-no-authority.test.ts` unchanged.
2. **Confirmation saves only a PENDING request.** Every saved preview has `approvalRequired: true` and the base policy unchanged except `mode: "SIMULATION"`. Requested leverage never enters that policy. Only separate operator review and freeze can lead to execution.
3. **Code owns selection and facts.** Validate the shared `StrategyIntent`; treat model prose and visitor text as untrusted data. Never change Score, frozen policy or allocation rules through a prompt, nickname, vibe or retrieved context.
4. **The server owns the voice session.** The browser data channel permits exactly `response.item.create`, `response.create`, `session.close`; it cannot replace prompts, tools, models or delegation.
5. **Keep controls intact.** `CHAT_ENABLED` and `LIVE_ENABLED` default off and are independent. Preserve rate limits, reservations, shared daily budget, microphone teardown, response guards and speech suppression of sound effects.
6. **Keep development materials out of production.** Preserve the `NODE_ENV`-guarded dynamic imports and the `/parrot/lab` `outputFileTracingExcludes` entry in `next.config.ts`.

### Instructions for agents editing this feature

Read root `AGENTS.md` and `packages/dashboard/AGENTS.md` first. Check current source and tests rather than older PRs or memory. Keep changes behavior-preserving unless a feature change is explicitly requested; preserve sound mapping, persona text and HTTP shapes. Do not add dependencies.

These files belong to other workstreams: `packages/shared/strategy-intent.ts`, `packages/backend/src/strategy-intent-adapter.ts`, `packages/backend/test/strategy-intent.test.ts`, `packages/backend/scripts/review-input.ts`, backend `src/pipeline/*`, `src/paper/*`, `src/score/*`, `packages/executor/**`, `.github/workflows/*`, root `AGENTS.md`, root `README.md`, and `vercel.json`. Read them to understand integration; do not edit them for a Parrot cleanup.

Run both packages' type checks and tests, then the dashboard webpack build and production marker scan below. For selection, context or scheduler refactors, also run the relevant mutation script. Use local tools for offline work; do not install packages or run provider evaluations without network authorization. Make small English commits when Git permissions allow.

## Visitor preferences and available facts

The seven intent variables come from `packages/shared/strategy-intent.ts`; `reply` and `clarify` are conversation fields, not additional selection variables.

| Variable | Values | Effect |
| --- | --- | --- |
| `riskStyle` | `aggressive`, `balanced`, `conservative` | Changes wallet ordering/window |
| `maxSources` | Integer 5–25 | Requested maximum N; never automatically increased |
| `avoidClones` | Boolean | Excludes clone or unknown clone status when true |
| `diversification` | `low`, `medium`, `high` | Noted only |
| `leverageComfort` | `low`, `medium`, `high` | Noted only |
| `horizon` | `short`, `medium` | Noted only |
| `requestedLeverage` | `null` or number >0 and ≤1000 | Display/context only, including requests such as 100x |

Aggressive uses top Score; balanced uses lowest maxDrawdown in the top-2N Score window. Conservative calls the shared shortlist with `M = min(25, ceil(1.2 × N))`, uses its top-2M window and lowest realizedVol ordering, then retains at most N. Eligibility and clone filters still apply. Parrot never calls the shared policy-tightening compiler `intentToPreview`.

The response policy summary remains `{ changes: [], clamps: [], maxSources }`. The empty arrays are retained for wire compatibility, not policy adjustments. Saved previews use the same selector, round cash upward to millionths and require exact integer allocation totals. Infeasible base-policy allocations return HTTP 422; the service does not rewrite policy or increase N. The deterministic `perpparrot:parrot-preview:v1` hash binds the structured intent, simulation policy and allocation; it grants no authority. Clarification responses contain no policy or shortlist and do not load candidates.

| What the Parrot can explain | Source and limits |
| --- | --- |
| Shortlist and changes | Selected addresses, stable nicknames, original Score rank, rounded drawdown/volatility, code-owned tags and membership reasons |
| Score period return / Sharpe | Optional finite metrics from live finalists; not forecasts or annualised volatility |
| Live-book comparison | Unique, case-insensitive overlap with active configuration sources |
| Paper performance | Up to three existing copy books, first-to-last available points within the last 30 days; never performance of the new shortlist |
| Live-book exposures | Gross and top three absolute exposures from the last stepped snapshot targets; not a fresh measurement of executed positions |

Live questions about comparison, paper performance or the live book refresh facts using the same preferences. Facts retain the no-orders/operator-review statement, mention at most three added and three removed wallets and fit within 1200 characters; context is appended only if it fits. The board displays available context as a muted line, including in Calm mode. React renders text as text; no live transcript is shown.

## Data, caches and fallbacks

| Read | Current behavior |
| --- | --- |
| Finalist pool | `server.ts` reads `pipeline_accounts` rows whose `listed_at` is within ten minutes of the latest stored listing. `chat/finalists.ts` runs unchanged `scoreCandidates`, then the team's `mapScoreFinalists` (up to 25), with clone status from Score. This is stored pipeline data, not a fresh Hyperliquid fetch on each conversation. |
| Finalist cache | Process-local five-minute cache, including fallback results; concurrent callers share one in-flight computation. |
| Sample fallback | No database, fewer than 30 rows with portfolios, fewer than five mapped finalists, or a read/Score failure uses the labelled bundled sample. Malformed individual portfolios are skipped. |
| Preview base policy | `configurations.load` uses the same configuration source as snapshots. Chat dependencies retain the validated policy after a successful load; failed loads can retry. |
| Comparison | Independently loads active configuration source addresses on each context request. |
| Paper | `paperStore.points(nowSeconds - 30 days)`; only default copy books with at least two usable points and positive initial equity. |
| Exposures | `paper.view(...).lastRunAt` identifies the last stepped run; the stored snapshot yields targets via `exposuresFromSnapshot`. Cache is keyed by that run timestamp. No snapshot is generated here. |
| Context failure | Three parallel reads, each with a two-second deadline; unavailable parts are independently omitted and logs contain only the part name. Context never enters previews. |
| Verify panel | Read-only `/artifacts/funnel` and `/paper` requests every minute while enabled; cached demos supply no verification evidence. |

Only **SAMPLE DATA** and **CACHED DEMO** are badges. Normal live data, paper replay and published artifacts have no badges. `shortlist.dataSource` still identifies `live` or `sample` in responses. Cached demo is an explicit browser fallback for disabled/unavailable/network conditions, with hand-authored examples and no server save. Backend sample fallback can coexist with available read-only book context; bundled sample and cached-demo fixtures themselves contain no context or extra return/Sharpe evidence.

The sample contains 40 deterministic synthetic rows: 36 generated equity paths (including eight clone copies) processed by Score and four exclusion controls. Seed 20261006 generates fake addresses from SHA-256(seed:index). The generated identity registry keeps all sample nicknames stable and unique; the six cached-demo identities are also stable and unique. Arbitrary live ids use a finite hash-name vocabulary and may collide.

Vibes are presentation only. Calm requires drawdown <3% **and** native, non-annualised realizedVol <1.5%; Wild requires drawdown ≥8% **or** realizedVol ≥3%; otherwise Steady. Missing or invalid either metric is neutral Steady. `VIBE_THRESHOLDS` also supplies evidence-tag thresholds. Measurements of sample membership changes are in [Wallet board verification](WALLET-BOARD-VERIFICATION.md).

## Endpoints and configuration

Local backend paths below are served under `/api/backend` on Vercel. Browser requests stay on the same origin and omit cookies.

| Endpoint | Input → result | Switch |
| --- | --- | --- |
| `POST /decide/receipt` | `{claim}` only → receipt grounding, relation probabilities and exact JSON call | `DECISIONS_ENABLED=true` plus API key |
| `POST /live/session` | `{sdp}` only → server-created session id, answer SDP, browser countdown; no client config forwarding | `LIVE_ENABLED=true` plus API key |
| `POST /live/strategy` | `{intent, previous?}` → checked shortlist, evidence, changes, facts and optional context; no model call | `LIVE_ENABLED=true` |
| `POST /chat` | `{message, history?}` → strict model intent and selection, or clarification without selection | `CHAT_ENABLED=true` plus API key |
| `POST /chat/preview` | `{intent}` → saved pending request id and simulation preview | `CHAT_ENABLED=true` |

`previous` accepts up to 25 distinct known finalist ids; unknown ids/keys are rejected. The shared preview limiter also covers `/live/strategy`. Rate/budget rejections return 429 with `retryAfterSec`. Only a definite provider 4xx releases the reservation; 5xx, timeouts and unusable bodies retain it. Provider bodies and keys never reach the browser.

| Environment variable | Default / purpose |
| --- | --- |
| `OPENAI_API_KEY` | Server-only key for text intent extraction, voice sessions and receipt Decisions |
| `CHAT_ENABLED` / `LIVE_ENABLED` | Off; only literal `true` enables each |
| `DECISIONS_ENABLED` | Off; only literal `true` enables receipt calls |
| `DECISIONS_MODEL` | `gpt-6-luna`; server-owned model |
| `DECISIONS_PRICE_PER_M_USD` | 0.10; estimate per million input tokens, no output charge |
| `DECISIONS_IP_HOURLY_LIMIT` / `DECISIONS_GLOBAL_DAILY_LIMIT` | 30 / 500; independent call counts, shared daily budget |
| `CHAT_MODEL` | `gpt-5.4-mini` |
| `CHAT_IP_SALT` | `perpparrot-chat-v1`; hashes client IP for limiter storage |
| `CHAT_DAILY_BUDGET_USD` | 5; shared chat/Live/Decisions reservation budget |
| `CHAT_IP_HOURLY_LIMIT` / `CHAT_GLOBAL_DAILY_LIMIT` | 10 / 100 |
| `CHAT_PREVIEW_IP_HOURLY_LIMIT` / `CHAT_PREVIEW_GLOBAL_DAILY_LIMIT` | 30 / 500 |
| `CHAT_PRICE_IN_PER_M_USD` / `CHAT_PRICE_OUT_PER_M_USD` | 1 / 4; reservation estimates |
| `LIVE_MODEL` / `LIVE_BACKEND_MODEL` | `gpt-live-1` / `gpt-5.6-terra` |
| `LIVE_VOICE` / `LIVE_BACKEND_REASONING` | `gleam` / `medium` |
| `LIVE_MAX_SESSION_SECONDS` | 180; integer 1–900, browser countdown only |
| `LIVE_IP_HOURLY_LIMIT` / `LIVE_GLOBAL_DAILY_LIMIT` | 3 / 30 sessions |
| `LIVE_VOICE_PRICE_PER_MIN_USD` / `LIVE_BACKEND_ALLOWANCE_USD` | 0.05 / 0.15; per-minute estimate plus per-session allowance |

Invalid optional numeric settings fall back to defaults. Session reservations use at least 15 seconds plus the backend allowance. Database configuration and frozen-configuration loading follow the runbook. Apply migrations `20261006140000_chat.sql`, then `20261007000000_live_usage.sql` and `20261008000000_decisions_usage.sql`; without a database, request/limiter stores are in-memory and do not provide durable or cross-instance state.

### Receipt Guillotine

`/parrot/receipts` lets the Parrot face the paperwork: choose one of six sentences or type 3–200 characters. The **OpenAI Decisions API** judges whether that sentence agrees with a code-owned **SAMPLE DATA** receipt, with a `supported_by_facts` probability and a `relation` choice: faithful, contradicted, unestablished or ambiguous. This is grounding against supplied facts, not market truth, future performance or advice. Nothing enters the selection, policy or execution pipeline.

The receipt contains two invented wallets: A has -8% drawdown and Sharpe 1.1; B has -20% and 1.4 over 30 days. Fees and coins are explicitly absent. Only the visitor's typed claim and this fixed sample receipt are sent as data to OpenAI, with fixed server-owned questions. Nicknames are presentation only. Claims and receipts are labelled data, never instructions. Input validation rejects extra body keys and control/bidi characters. The UI renders all text through React and stores nothing. The server keeps the provider key; the Lens reveals only exact JSON request/response bodies after strict validation, never headers.

The always-visible **Decisions Lens** shows both questions, all five probabilities, measured browser round trip and server latency, input tokens and estimated input-only cost. Its call toggle exposes the real request and response. The visit counter counts validated successful results and their estimated costs; failed attempts can still incur cost. Raw provider field names are preserved in the JSON inspector. No synthetic telemetry is presented as an API result.

Enable `DECISIONS_ENABLED=true` and the server key for real calls; the switch defaults off independently of Chat and Live. The route shares their CORS pattern and the browser's same-origin `backendFetch` guard. It uses the existing atomic limiter with kind `decide`, a reservation based on twice the serialized request byte size (including framing allowance), and an eight-second AbortController deadline. Successful usage settles to reported input-token cost; definite upstream 4xx releases cost, while 5xx, timeout and unusable responses retain the reservation. Limits use the existing shared daily budget and IP hashing. Apply the Decisions migration before enabling the route. Memory-only limits remain process-local.

On disabled, rate-limited or failed requests, **CACHED DEMO** offers six hand-authored preset results. The Lens says **cached, no API call**, describing the displayed illustration; the preceding failed attempt may have reached the provider. Free text is disabled with a reason. Cached examples have no request/response, token count, latency or charged cost. Reload after the operator restores service to try live calls again.

Residual risks: the API is beta (GA expected within weeks); the parser reads `answers`, `model` and `usage.input_tokens` and ignores other usage detail fields, which the real API returns (recorded fixture `packages/backend/test/fixtures/decisions.recorded.json`). The two questions can disagree (a real run called "Wallet A had the higher Sharpe." faithful with 0% support), so the page stamps UNCLEAR when the relation and `supported_by_facts` contradict each other (`settle` in `lib/parrot-receipts.ts`) and shows that disagreement. Accuracy beyond the 18-sentence check below, sarcasm and languages other than English and Japanese are unverified; output is a model's opinion about the sentence, never about the market. Prompt-injection resistance is an instruction boundary, not a guarantee. Pricing is a configurable estimate, provider rate limits are undocumented, and byte-based reservations are conservative estimates rather than provider billing caps. Provider spend controls remain an operational backstop.

Offline checks: `bun packages/backend/scripts/receipt-mutations.ts` exercises claim-only validation, the relation enum, 4xx budget release and the browser's unknown-key guard in a disposable tree. It requires assertion RED, restored GREEN and matching workspace/disposable SHA-256. The real-Postgres migration test skips without `TEST_DATABASE_URL`. Offline tests cannot establish provider compatibility, real billable cost, deployment, visual layout, animation, sound or browser interaction acceptance.

### Run locally

Backend, from `packages/backend` (memory stores and labelled sample; no database required):

```sh
CONFIGURATION_PATH=fixtures/frozen-configuration.json \
FROZEN_CONFIGURATION_HASH=<configurationHash from that file> \
CHAT_ENABLED=true LIVE_ENABLED=true OPENAI_API_KEY=<local secret> \
PORT=8788 bun run src/server.ts
```

Dashboard, from `packages/dashboard`: `bun run dev`, then open `http://localhost:3000/parrot`. The development rewrite points `/api/backend` to port 8788. Real voice/text calls require provider access; offline inspection can use cached demo or the labs. Allow microphone access in the browser for voice testing. End, cancellation, hidden tab, errors and countdown expiry close media; unfinished strategy updates clear the confirmable plan.

Deployment uses the existing Vercel project and service routing. Someone with Vercel team access must add `OPENAI_API_KEY` and the desired switches to the correct project/environment; GitHub Actions secrets are not automatically Vercel environment variables. Keep Live disabled outside the intended demo window. No deployment is implied by an offline build.

### Verify offline

With existing local dependencies (no installation/network required):

```sh
(cd packages/backend && bunx --no-install tsc --noEmit && bun test)
(cd packages/dashboard && bunx --no-install tsc --noEmit && bun test && NEXT_TELEMETRY_DISABLED=1 bun run build --webpack)
# Expected: no matches (rg exit status 1). Do not ignore an rg error.
rg -l 'Copy my picks|Run scenario|parrot-sfx-catalog|PARROT_MATERIALS_RECIPES_DEV_ONLY_V1|lab-safe' \
  packages/dashboard/.next/static packages/dashboard/.next/server
bun packages/backend/scripts/check-wallet-board-mutations.ts
bun packages/backend/scripts/live-context-mutations.ts
```

Mutation scripts must report GREEN baseline, assertion failures for each intentional RED mutation, then GREEN restoration and matching SHA-256 hashes. They edit disposable copies only. Database tests skip without `TEST_DATABASE_URL`; provider evaluation scripts are separate, networked checks.

## File map

Paths below are relative to the repository root; wildcard entries group files with one responsibility.

| Area | Path | Responsibility |
| --- | --- | --- |
| Backend wiring (read for integration) | `packages/backend/src/server.ts` | Routes, environment, configuration policy and named read-only data dependencies |
| Chat | `packages/backend/src/chat/handler.ts` | Intent extraction, limiter use and pending-request persistence |
| Chat model / limits | `packages/backend/src/chat/{prompt,openai,budget,limits}.ts` | Prompt/schema boundary, provider adapter and atomic reservations |
| Finalists | `packages/backend/src/chat/finalists.ts` | Score stored pipeline accounts; cache or fall back to sample |
| Selection / preview | `packages/backend/src/chat/{strategy,preview}.ts` | Shared shortlist projection, evidence/reasons, simulation allocations and hash |
| Live | `packages/backend/src/live/{config,handler}.ts` | Server-owned WebRTC session and code-built strategy response |
| Receipt backend | `packages/backend/src/live/decisions.ts` | Fixed Decisions request, bounded provider call, kill switch and shared-budget handler |
| Receipt contract | `packages/shared/receipt.ts` | Code-owned sample receipt, questions and strict server/client response guards |
| Receipt page | `packages/dashboard/app/parrot/receipts/{page,ReceiptClient}.tsx`, `packages/dashboard/app/parrot/receipts/receipts.css` | Claims, preset fallback, playful verdict and reduced-motion snip |
| Decisions Lens | `packages/dashboard/components/parrot/DecisionsLens.tsx`, `packages/dashboard/lib/parrot-receipts.ts` | Real telemetry/call inspector and explicitly hand-authored demo fixtures |
| Receipt verification | `packages/backend/test/decisions*.test.ts`, `packages/dashboard/test/receipts.test.tsx`, `packages/backend/scripts/receipt-mutations.ts` | Parser, handler, migration, guard/render and disposable RED/GREEN checks |
| Receipt migration | `supabase/migrations/20261008000000_decisions_usage.sql` | Add `decide` to the usage-kind constraint |
| Context | `packages/backend/src/live/context.ts` | Independent comparison, paper and exposure summaries |
| Shared presentation | `packages/shared/wallet-persona.ts` | Stable nicknames and cosmetic vibe thresholds |
| Shared evidence | `packages/shared/wallet-evidence.ts` | Display evidence and closed reason vocabulary |
| Shared context | `packages/shared/live-context.ts` | Read-only context wire shape |
| Shared sample | `packages/shared/sample-wallet-ids.ts` | Generated synthetic nickname collision registry |
| Dashboard page | `packages/dashboard/app/parrot/{page.tsx,parrot.css}` | Conversation, selection state, demo fallback and page styling |
| Dashboard interaction | `packages/dashboard/components/parrot/{useLiveTalk,LiveTalk,ParrotAvatar,api}.tsx` or `.ts` | Voice lifecycle, checked same-origin requests and call UI |
| Dashboard review | `packages/dashboard/components/parrot/{StepRail,SelectPanel,VerifyPanel,ExecutePanel,HoldButton,useVerification}.*` | Selection, existing evidence and pending-request confirmation |
| Dashboard presentation | `packages/dashboard/components/parrot/{WalletBoard,WalletBird,ParrotEffects,Badge,ThemeToggle}.tsx` | Tiles, ghosts, sound/motion controls, two fallback badges and theme |
| Dashboard contracts | `packages/dashboard/lib/{parrot,parrot-live,parrot-context,parrot-presets}.ts` | Guards, event reducer, context line and cached examples |
| Dashboard effects | `packages/dashboard/lib/{wallet-board,parrot-sfx}.ts` | Pure diffs/schedules and Web Audio synthesis/cleanup |
| Development labs | `packages/dashboard/app/parrot/lab/*`, `components/parrot/EffectsLab.tsx`, `lib/parrot-lab-*.ts`, `lib/parrot-sfx-catalog.ts` (dashboard) | Local auditions, scenario, fixtures and alternative recipes |
| Backend contract tests | `packages/backend/test/{chat-*,parrot-contract,parrot-policy-source,parrot-no-authority}.test.ts` | Request validation, preview invariants, shared ownership and source scan |
| Backend Live tests | `packages/backend/test/{live-*,parrot-live-*}.test.ts` | Config, provider mock/replay, reducer and independent context failures |
| Backend wallet/UI helper tests | `packages/backend/test/{wallet-*,parrot-ui-helpers,parrot-hold-review}.test.ts` | Selection/evidence, vibe boundaries, pure effects and confirmation guards |
| Dashboard tests | `packages/dashboard/test/*` | Rendered labels/controls, protocol guards, materials timing and mocked audio cleanup |
| Synthetic data / measurements | `packages/backend/scripts/{make-sample-finalists,measure-wallet-board}.ts` | Regenerate sample and print pairwise membership turnover |
| Disposable mutation checks | `packages/backend/scripts/{live-mutations,live-context-mutations,check-wallet-board-mutations,check-wallet-persona-mutations}.ts` | Named RED/GREEN controls; not discovered by `bun test` |
| Provider evaluation (networked) | `packages/backend/scripts/eval-chat-prompt.ts` | Real-model extraction checks; not part of offline verification |

## Development-only labs

- **Materials:** open `/parrot/lab` under `bun run dev`. Unlock audio, audition catalog entries, choose sounds for a mock scenario, copy picks as text and swap synthetic flocks. Picks live only in component state; there are no backend or OpenAI calls.
- **Effects:** open `/parrot?fx=1` in development for preset swaps, banners and individual sound auditions in the product layout. The boundary cue/banner is retained for lab use; it does not mean product policy is adjusted.
- **Production:** `/parrot/lab` returns 404. `/parrot?fx=1` remains the ordinary product page with no lab overlay. Both dynamic imports remain behind `NODE_ENV` guards; file tracing separately excludes the raw lab client.

Production sound mapping stays whistle (start), bubble (arrival), pop (removal), ticks then metallic sprinkle (reels), and ta-da (pending request). The `clamp` event maps to the lab's soft nope. `Fever` names the existing visual banner; it is not an additional sound cue. Reels and feathers celebrate selection or pending requests, never returns. Speech suppresses sound, removed tiles last about 2.5 seconds, and Calm/reduced motion retain static states. Product Sound/Calm buttons are currently hidden; defaults are sound on/Calm off, with `?sound=0` and `?calm=1` overrides. Labs expose audition controls.

## Verification record

| Date | Verified and how | Not established |
| --- | --- | --- |
| 2026-10-07 | Receipt Guillotine offline: backend 703 pass / 23 skip; dashboard 93 pass; both package type checks; webpack build includes `/parrot/receipts`; no production lab markers. Four disposable assertion RED/restored GREEN checks with matching SHA-256. 320 added product lines including shared contract/CSS/route wiring, plus one limiter type edit and four migration lines. | Actual Decisions API response compatibility, provider cost/latency, real Postgres, deployment and browser/audio/visual acceptance |
| 2026-10-07 | Receipt Guillotine against the real Decisions API through the local backend and page (18 sentences incl. paraphrases, Japanese, sarcasm, two instruction-injection attempts): relation correct 16/18, latency 330-712 ms (mean 453 ms), injection attempts not obeyed. The first real run exposed a parser mismatch (extra `usage` fields), fixed with a recorded-response test; one preset was ambiguous without a comparator and was reworded. Backend 722 pass with real Postgres; dashboard 94 pass. | Sustained accuracy, beta stability under load, sarcasm/other languages, deployment, sound and visual acceptance on a phone |
| 2026-10-06 | Prior real-provider text-driven WebRTC recording: session creation, delegated tool, blocked reconfiguration, limiter and close events | Current exploration behavior, real browser microphone/voice or deployment |
| 2026-10-07 | Offline refactor: backend 659 pass / 20 skip, dashboard 65 pass; both TypeScript checks, webpack build, production marker scan and disposable scheduler/context RED/GREEN with SHA-256 restoration | Database tests, provider rerun, live Hyperliquid distribution, deployment, audio or visual acceptance |

The recorded protocol fixture is a replay with enum spelling adapted to the shared contract, not a new provider recording. [Wallet board verification](WALLET-BOARD-VERIFICATION.md) preserves the synthetic swap measurements.

## Residual risks and unverified items

| Item | Boundary / remaining check |
| --- | --- |
| Session duration | Browser-only countdown; a modified client can stay connected longer. Session counts and reservations do not impose a server-side duration cap. |
| Backend-model cost | Per-session cost is uncapped; repeated delegated calls can exceed the allowance. Provider spend controls are an operational backstop. |
| Client IP trust | Limiter uses the first `x-forwarded-for` value. Verify the deployment ingress overwrites untrusted values before enabling public access. |
| Vibe calibration | Thresholds are calibrated to synthetic data, not a real Score distribution. |
| Live data | Real Hyperliquid finalists/context have not been observed in this offline verification. Stored-data freshness and finite nickname collisions need live inspection. |
| Browser acceptance | Real microphone, voice quality, sound, animation, layout, focus, screen-reader behavior and photosensitivity remain unverified. Mock audio/render tests cannot hear or see. |
| Infrastructure | Postgres tests skip without `TEST_DATABASE_URL`; Linux, Vercel deployment and default Turbopack build were not verified here. |

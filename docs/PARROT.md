# Parrot: wallet exploration over the existing pipeline

## Start here

- [Overview and documentation index](parrot/README.md)
- [Developer integration, setup and deployment checklist](parrot/INTEGRATION.md)
- [Presenter script, fallbacks and honest claims](parrot/DEMO.md)

This is the technical reference for selection semantics, wire contracts, lifecycle details and recorded verification. The root [design](../README.md), [runbook](ops/RUNBOOK.md) and [AI review integration](agents/INTEGRATION.md) describe the surrounding pipeline.

## Invariants

The canonical [invariants and ownership boundaries](parrot/INTEGRATION.md#invariants-and-ownership) live in the integration guide.

### Instructions for agents editing this feature

Follow the integration guide's [ownership rules](parrot/INTEGRATION.md#invariants-and-ownership) and [pre-merge / pre-deploy checklist](parrot/INTEGRATION.md#pre-merge--pre-deploy-checklist). Verification commands remain [below](#verify-offline).

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

Live questions about comparison, paper performance or the live book refresh facts using the same preferences. Facts retain the no-orders/operator-review statement, mention at most three added and three removed wallets and fit within 1200 characters; context is appended only if it fits. The board displays available context as a muted line, including in Calm mode. React renders text as text. When receipt judging has succeeded in the current call, `/parrot` shows only the newest completed Parrot sentence in one compact receipt; the full sentence and evidence are available on demand. The optional `/parrot/receipts/live` view displays a sentence feed.

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
| `POST /decide/receipt` | `{claim}` (sample) or `{claim, facts}` (turn receipt) → fact predicate, grounding, relation probabilities and exact JSON call | `DECISIONS_ENABLED=true` plus API key |
| `POST /live/session` | `{sdp}` only → server-created session id, answer SDP, browser countdown; no client config forwarding | `LIVE_ENABLED=true` plus API key |
| `POST /live/strategy` | `{intent, previous?}` → checked shortlist, evidence, changes, facts and optional context; no model call | `LIVE_ENABLED=true` |
| `POST /live/plan` | Validated intent → reviewable simulation plan; does not save | `LIVE_ENABLED=true` |
| `POST /live/request` | Explicit confirmation → saved pending simulation request; no trade authority | `LIVE_ENABLED=true` |
| `POST /chat` | `{message, history?}` → strict model intent and selection, or clarification without selection | `CHAT_ENABLED=true` plus API key |
| `POST /chat/preview` | `{intent}` → saved pending request id and simulation preview | `CHAT_ENABLED=true` |

`previous` accepts up to 25 distinct known finalist ids; unknown ids/keys are rejected. The shared preview limiter also covers `/live/strategy`. Rate/budget rejections return 429 with `retryAfterSec`. Only a definite provider 4xx releases the reservation; 5xx, timeouts and unusable bodies retain it. Provider bodies and keys never reach the browser.

Environment defaults, Vercel ownership and migration order have one home in [Integration](parrot/INTEGRATION.md#environment-and-vercel-ownership). Session reservations use at least 15 seconds plus the backend allowance.

### Receipt Guillotine

`/parrot/receipts` lets the Parrot face the paperwork: choose one of six sentences or type 3–200 characters. The **OpenAI Decisions API** judges whether that sentence agrees with a code-owned **SAMPLE DATA** receipt, with two predicates (`states_a_fact`, `supported_by_facts`) and a `relation` choice: faithful, contradicted, unestablished or ambiguous. This is grounding against supplied facts, not market truth, future performance or advice. Nothing enters the selection, policy or execution pipeline.

The receipt contains two invented wallets: A has -8% drawdown and Sharpe 1.1; B has -20% and 1.4 over 30 days. Fees and coins are explicitly absent. In sample mode, only the visitor's typed claim and this fixed sample receipt are sent as data to OpenAI, with fixed server-owned questions. Nicknames are presentation only. Claims and receipts are labelled data, never instructions. Input validation rejects extra body keys and control/bidi characters. The UI renders all text through React and stores nothing. The server keeps the provider key; the Lens reveals only exact JSON request/response bodies after strict validation, never headers.

The always-visible **Decisions Lens** shows all three questions and six probabilities (the cached sample illustrations have no fact-predicate value), measured browser round trip and server latency, input tokens and estimated input-only cost. Its call toggle exposes the real request and response. The visit counter counts validated successful results and their estimated costs; failed attempts can still incur cost. Raw provider field names are preserved in the JSON inspector. No synthetic telemetry is presented as an API result.

Enable `DECISIONS_ENABLED=true` and the server key for real calls; the switch defaults off independently of Chat and Live. The route shares their CORS pattern and the browser's same-origin `backendFetch` guard. It uses the existing atomic limiter with kind `decide`, a reservation based on twice the serialized request byte size (including framing allowance), and an eight-second AbortController deadline. Successful usage settles to reported input-token cost; definite upstream 4xx releases cost, while 5xx, timeout and unusable responses retain the reservation. Limits use the existing shared daily budget and IP hashing. Apply the Decisions migration before enabling the route. Memory-only limits remain process-local.

On disabled, rate-limited or failed requests, **CACHED DEMO** offers six hand-authored preset results. The Lens says **cached, no API call**, describing the displayed illustration; the preceding failed attempt may have reached the provider. Free text is disabled with a reason. Cached examples have no request/response, token count, latency or charged cost. Reload after the operator restores service to try live calls again.

Residual risks: the API is public beta (general-availability timing is not verified); the parser reads `answers`, `model` and `usage.input_tokens` and ignores other usage detail fields, which the real API returns (hand-extended fixture `packages/backend/test/fixtures/decisions.hand-extended.json`: it replaces the old two-answer fixture, preserving its recorded usage shape but adding a synthetic `states_a_fact` answer; it is **not** a new API recording). The grounding and relation questions can disagree (a real run called "Wallet A had the higher Sharpe." faithful with 0% support), so the page stamps UNCLEAR when the relation and `supported_by_facts` contradict each other (`settle` in `lib/parrot-receipts.ts`) and shows that disagreement. Accuracy beyond the 18-sentence check below, sarcasm and languages other than English and Japanese are unverified; output is a model's opinion about the sentence, never about the market. Prompt-injection resistance is an instruction boundary, not a guarantee. Pricing is a configurable estimate, provider rate limits are undocumented, and byte-based reservations are conservative estimates rather than provider billing caps. Provider spend controls remain an operational backstop.

Offline checks: `bun packages/backend/scripts/receipt-mutations.ts` exercises facts validation, required `states_a_fact`, facts/request consistency, the two-request cap, drop-oldest waiting, sample override rejection, the relation enum, 4xx budget release and the browser's unknown-key guard in a disposable tree. It requires assertion RED, restored GREEN and matching workspace/disposable SHA-256. The real-Postgres migration test skips without `TEST_DATABASE_URL`. Offline tests cannot establish provider compatibility, real billable cost, deployment, visual layout, animation, sound or browser interaction acceptance.

#### Live sentence receipts

`/parrot/receipts/live` reuses Talk/End, microphone mute, the avatar and the moving flock. It observes validated `session.output_transcript.delta` fragments and each successful `/live/strategy` result through optional hook callbacks. The production `/parrot` page uses the same `useSentenceReceipts` observer pipeline with the compact placement described below. Judgments are display-only: never fed back to Live, selection, policy or trading.

Each completed sentence enters the feed as **checking...** before a Decisions call finishes (`Checking…` in the production card once judging has worked). Its receipt is the exact code-built `LiveStrategy.facts` available when the sentence is queued. A new strategy flushes the old text against the old facts before resetting the turn budget; old in-flight/waiting sentences keep their original receipt. The receipt box shows current facts, and selecting an older card also exposes the receipt used for that sentence. The server accepts only `{claim}` or `{claim, facts}`: claim 3–200 characters, supplied facts 20–1200 characters, no control/bidi characters or extra keys. Questions remain fixed on the server. The browser validates the three-answer result, claim and exact receipt before displaying it.

`states_a_fact < 0.5` dims a sentence as **banter**, with no stamp/cut/verdict sound. Other sentences use `settle` and the existing four stamps; conflicting grounding/relation answers become UNCLEAR. The Lens includes `states_a_fact` and **Show the call** with exact JSON (including original provider field names). Newest cards appear first; only 20 are retained. The call counter counts started judge attempts and sums estimated cost only for validated results; failed/aborted attempts can still be billed.

The pure queue allows two in-flight calls and eight waiting sentences; overflow drops the oldest waiting sentence and counts it as skipped. It starts at most 12 calls per strategy turn, deduplicates consecutive identical sentences, and skips greetings before facts exist. HTTP 503/429 pauses all judging for the rest of the voice call (**Receipts paused**); strategy updates do not unpause it. Other failures mark that sentence unavailable in the standalone live feed; the production compact surface pauses judging on any failure (including 404, network errors, timeouts and rejected response guards). End/unmount aborts all requests and waiting work, clears segmentation timers and discards unfinished text. A new Talk call gets a fresh queue. The labelled cached fallback shows only a bundled flock, never fabricated live verdicts.

Only `/parrot/receipts/live` retains verdict cues: sprinkle/nope/bubble, at most one per 700 ms, suppressed in Calm/reduced-motion mode, while hidden, or within the same 1200 ms visitor-input quiet window used by Live effects. Cuts use the existing non-flashing animation and reduced-motion CSS. There is no browser storage.

#### Production placement: A2 / 1 line

The owner-approved A2 **1 line** layout is on the real `/parrot` page: directly below End/Mute and the existing status/countdown, before the flock in reading order. One centered card, at most 320 px wide, has the exact header **Audited by OpenAI Decisions** (no latency or call count). Its one 44 px minimum tap row shows the newest completed sentence on one ellipsized line, the existing `settle` / `STAMPS` verdict and grounding percentage with a hairline meter. Text stays at least 12 px; tokens follow light/dark themes. Banter (`states_a_fact < 0.5`) shows only “banter” beside the sentence, without a stamp or percentage. Contradicting predicate/relation answers in either direction produce UNCLEAR; there is one real three-question Decisions result, not the mock's invented two-call aggregation.

The card is **hidden until a strictly validated judgment succeeds in this voice call**. Never-enabled, 503/404, network-error and never-succeeded states add no live-area markup. Subsequent checks show “Checking…” on their own sentence; a late result updates only its original sentence record. After a failure following success, the row says **Receipts paused**, with no stamp or percentage; voice continues, and a new Talk call retries. End/unmount abort work and clear segmentation timers. No cached or fake live stamps, storage, model feedback or strategy/policy changes are introduced.

Clicking the header or row opens a native modal **Decisions Lens** drawer (`showModal`): contained browser focus, Escape/Close, and focus returned to the opener. It shows **OpenAI Decisions API · gpt-6-luna · beta** (the actual returned model when different), the full selected sentence, its pinned turn facts, `states_a_fact`, `supported_by_facts`, all four relation probabilities, round-trip and server ms, input tokens, estimated cost, visit call attempts/cost and **Show the call** with exact request/response JSON rendered as React text. The selector retains the last ten judged sentences, including banter and disagreements; a selected or pending sentence remains inspectable while new speech arrives. Opening the drawer does not pause voice or judging. Visit totals span calls in this mounted page, while per-call evidence and availability reset on Talk; failed/aborted attempts can still incur unreported cost.

Production receipts are **silent**, with no verdict sounds or added animations; existing Live effects and speech suppression remain unchanged. Polite announcements are coalesced to at most one per 1.5 seconds and only announce stamped sentences. Reduced-motion disables receipt/drawer animation and transitions. There is no extra caption, feed, counter or other persistent receipt surface. The existing footer reads **“Parrot's opinion, not advice. Receipts check words, not markets.”** and explains that OpenAI processes voice plus sentences and their turn facts when receipts are on.

Offline proof: `bun packages/dashboard/scripts/compact-receipt-mutations.ts` runs the real hook harness in disposable copies. Removing the never-worked guard and misapplying a late result to the latest row must each fail their named assertion, then pass after restoration with matching workspace/disposable SHA-256. `test/fixtures/parrot-live-before.html` freezes the live-stage markup captured from pre-integration commit `84ded11`; unavailable production renders compare byte-for-byte against it. The native-dialog host tests verify handlers and focus-return delegation, not actual browser Tab containment or screen-reader behavior.

Live-specific residual risks: sentence segmentation is heuristic, with punctuation lookahead, decimal/version/address exceptions, short-fragment merging and a 200-character cap. A 180 ms silence timer releases terminal punctuation, so a delayed decimal continuation or closing quote can still segment incorrectly; unfinished text on End is not judged. Output transcript timing is not audio playback timing, so a card/verdict may lead or lag what is heard. The owner measured the old two-question API at 0.33–0.71 s and roughly **$0.00005 per call**; the later typed-turn three-question measurement is recorded in [Verification record](#verification-record); sustained latency/cost and real spoken audio remain unverified. Accuracy on noisy transcripts, banter classification and sustained bursts is unverified. These verdicts remain a model opinion about the receipt, not market truth or advice. Public facts mode accepts caller-supplied text; it does not attest its provenance.

### Run locally

Use [local setup](parrot/INTEGRATION.md#migrations-and-local-setup) and the [presentation pre-flight](parrot/DEMO.md#prerequisites-and-pre-flight). End, cancellation, hidden tab, errors and countdown expiry close media; unfinished strategy updates clear the confirmable plan.

### Verify offline

With existing local dependencies (no installation/network required):

```sh
(cd packages/backend && bunx --no-install tsc --noEmit && bun test)
(cd packages/dashboard && bunx --no-install tsc --noEmit && bun test && NEXT_TELEMETRY_DISABLED=1 bun run build)
# Expected: no matches (rg exit status 1). Do not ignore an rg error.
rg -l 'Copy my picks|Run scenario|parrot-sfx-catalog|PARROT_MATERIALS_RECIPES_DEV_ONLY_V1|lab-safe' \
  packages/dashboard/.next/static packages/dashboard/.next/server
bun packages/backend/scripts/check-wallet-board-mutations.ts
bun packages/backend/scripts/live-context-mutations.ts
bun packages/dashboard/scripts/compact-receipt-mutations.ts
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
| Compact production receipt | `packages/dashboard/components/parrot/{CompactReceipt,DecisionsDrawer}.tsx` | A2 one-line card, silent throttled announcements and on-demand native modal Lens |
| Shared receipt observer | `packages/dashboard/components/parrot/useSentenceReceipts.ts` | One splitter/queue integration for both live pages; lifecycle, availability, visit totals and judged history |
| Compact receipt verification | `packages/dashboard/test/compact-receipts.test.tsx`, `test/fixtures/{sentence-receipts,receipt-interactions,parrot-off}.fixture.*` and `scripts/compact-receipt-mutations.ts` (dashboard) | Render states, real-hook fake judge/clock, modal host contract, frozen off markup, silence and two disposable RED/GREEN guards |
| Live receipts | `packages/dashboard/app/parrot/receipts/live/*`, `packages/dashboard/lib/parrot-{sentences,judge-queue}.ts` | Live sentence feed, heuristic segmentation, bounded judging and cleanup |
| Live receipt tests | `packages/dashboard/test/{parrot-sentences,parrot-judge-queue,live-receipts}.test.*`, `test/fixtures/live-hook.fixture.ts` (dashboard) | Streaming tables/fuzz, fake-clock queue/reducer integration, rendered fixtures and isolated real-hook lifecycle regression |
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
| 2026-10-07 | Owner-approved **A2 / 1 line** integrated on `/parrot`, offline only. Dashboard **138 pass** (all prior 123 unchanged), backend **714 pass / 23 skip** with backend files unchanged; both package `bunx --no-install tsc --noEmit` checks. Webpack lists `/parrot`, `/parrot/receipts`, `/parrot/receipts/live`; production lab-marker scan has no matches. Rendered row states, both disagreement directions, exact JSON, frozen pre-integration off markup, actual shared hook with fake judge/clock (ordering, caps, dedupe, pinned facts, failure/pause, restart totals and teardown), silent path, modal host contract/focus return, and stamped-only 1.5 s announcements. Both named disposable mutation guards assertion **RED**, restored **GREEN**, matching workspace/disposable SHA-256 (below). Diff: **188 added / 29 removed product lines; 570 added / 34 removed overall**, including tests, mutation script and docs. | No network or real API sessions. Actual provider compatibility, latency/billing, transcript/audio timing, banter/grounding quality, sustained real-call behavior, microphone/sound, rendered 375 px/desktop fit, light/dark contrast, zoom, motion comfort, native browser Tab/Escape/focus return and screen-reader announcements, live Hyperliquid data, Postgres, deployment, Linux and Turbopack remain unverified. Modal tests use a simulated host, not a browser. |
| 2026-10-07 | Live Receipt Guillotine, offline only: backend **714 pass / 23 skip**, dashboard **123 pass**; both `bunx --no-install tsc --noEmit` checks; webpack build includes `/parrot/receipts/live`; production lab-marker scan has no matches. Streaming boundary tables (every delta split point), seeded fuzz, fake-clock queue/reducer ordering, rendered verdict/banter fixtures, real-hook mocked-host regression and End/unmount cleanup. Nine disposable assertion RED/restored GREEN controls, including all five live requirements, with matching SHA-256. **227 added product lines** (186 new files + 41 additions to existing product files; 23 removed). | No network/API calls, real three-question provider compatibility, actual live latency/cost, noisy-transcript/banter quality, real microphone/audio/video timing, visual layout/cuts/sounds/reduced-motion or browser accessibility acceptance, live flock data, real Postgres, deployment, Linux or Turbopack. The recorded-shape fixture is explicitly hand-extended. |
| 2026-10-07 | Receipt Guillotine offline: backend 703 pass / 23 skip; dashboard 93 pass; both package type checks; webpack build includes `/parrot/receipts`; no production lab markers. Four disposable assertion RED/restored GREEN checks with matching SHA-256. 320 added product lines including shared contract/CSS/route wiring, plus one limiter type edit and four migration lines. | Actual Decisions API response compatibility, provider cost/latency, real Postgres, deployment and browser/audio/visual acceptance |
| 2026-10-07 | Receipt Guillotine against the real Decisions API through the local backend and page (18 sentences incl. paraphrases, Japanese, sarcasm, two instruction-injection attempts): relation correct 16/18, latency 330-712 ms (mean 453 ms), injection attempts not obeyed. The first real run exposed a parser mismatch (extra `usage` fields), fixed with a recorded-response test; one preset was ambiguous without a comparator and was reworded. Backend 722 pass with real Postgres; dashboard 94 pass. | Sustained accuracy, beta stability under load, sarcasm/other languages, deployment, sound and visual acceptance on a phone |
| 2026-10-07 | `/parrot/receipts/live` against a real GPT-Live session (typed turn through the data channel, silent synthetic microphone): 44 `session.output_transcript.delta` events streamed the parrot's words, 5 sentences were cut and judged by the real Decisions API while the parrot kept talking (2 banter, 2 MATCHES, 1 CONTRADICTED; round trip 415 ms, 822 input tokens per call with the turn's facts, about $0.00008 per call). One sentence the receipt arguably supports ("Preview built: conservative, five wallets, low leverage comfort, and no cloning bird approved.") was stamped CONTRADICTED at 42% grounding: the judge is a model opinion. Backend 733 pass with real Postgres; dashboard 123 pass. | Spoken audio and a real microphone, long calls, accuracy on noisy transcripts and other languages, visuals/sound on a phone, deployment |
| 2026-10-07 | The A2 compact receipt ("Audited by OpenAI Decisions", 1 line) on the real `/parrot` page against a real GPT-Live session (typed turn, silent synthetic microphone) in the in-app browser: the card stayed hidden before the call, showed banter / Checking… / a real verdict ("Preview: Conservative, five wallet sources, low leverage comfort, clone filtering on." MATCHES 99%; in an earlier run "Preview set, conservative, 5 new-to-you wallets." came back UNCLEAR at 18%, a model opinion). The first real run exposed a bug the unit tests could not see: React StrictMode's dev effect replay closed and reopened the native `<dialog>`, and the asynchronous `close` event then dismissed the open drawer after ~0.4 s; the drawer now ignores a `close` event while it is open (regression assertion proven red without the guard). Dashboard 138 pass; backend 733 pass with real Postgres. | Real microphone and spoken audio, production-mode drawer behaviour, light theme and phone widths, long calls, accuracy on noisy transcripts and other languages |
| 2026-10-06 | Prior real-provider text-driven WebRTC recording: session creation, delegated tool, blocked reconfiguration, limiter and close events | Current exploration behavior, real browser microphone/voice or deployment |
| 2026-10-07 | Offline refactor: backend 659 pass / 20 skip, dashboard 65 pass; both TypeScript checks, webpack build, production marker scan and disposable scheduler/context RED/GREEN with SHA-256 restoration | Database tests, provider rerun, live Hyperliquid distribution, deployment, audio or visual acceptance |

A2 mutation restoration hashes (full SHA-256, source and disposable copy matched):

- `useSentenceReceipts.ts` — hidden when never worked: `81404179f63f40ba8a4d18f1c8b907b251d13c535787826ff53419e542c47eef`.
- `parrot-judge-queue.ts` — late result updates only its own sentence: `9e874ee51a4104b4c52f0c3d70b5994ee53b4b0d59f59a40325a787d62b261fb`.

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
| Infrastructure | Postgres tests skip without `TEST_DATABASE_URL`. The historical rows above retain their original limits; current Linux build and CI results are recorded in the documentation audit. Neither proves real microphone/provider behavior or funded execution. |

# Presenting Parrot

[Overview](README.md) · [Setup and operator variables](INTEGRATION.md) · [Verification record](../PARROT.md#verification-record)

## Prerequisites and pre-flight

- [ ] Operator confirms [migrations and configuration](INTEGRATION.md#migrations-and-local-setup); a build does not prove deployment.
- [ ] Confirm server-side `OPENAI_API_KEY`, `LIVE_ENABLED=true`, `DECISIONS_ENABLED=true`, and `CHAT_ENABLED=true` for pending saves. Check remaining budget: rehearsals can exhaust the [default limits](INTEGRATION.md#environment-and-vercel-ownership).
- [ ] Rehearse `/parrot` on the presentation device. Allow microphone access; click **Enable audio** if blocked. Keep the page visible: hiding it ends the call. Check **End** and mute.
- [ ] Inspect source badges and context. Say “sample” when labelled. A missing badge does not prove freshness; ask the developer to check `shortlist.dataSource`.
- [ ] Prepare `/parrot/receipts` as fallback; read its sample receipt. End Live before switching tabs.
- [ ] Historical Live tests used typed turns and a silent synthetic microphone. Real microphone/spoken audio are **not verified**; rehearse before claiming working voice.

## Three-minute script

Timing is a rehearsal plan. End before navigating away; skip saving unless prepared with the operator.

| Time | Say | Click / do | Audience sees |
| --- | --- | --- | --- |
| 0:00–0:20 | “This is an optional wallet-exploration page. LLMs judge, code allocates. Everything here is simulation; this bird cannot trade.” | Open `/parrot`; point to the footer | Avatar, waiting flock and Talk live |
| 0:20–0:55 | “Show a conservative preview with five wallets, avoid clones, low leverage comfort, high diversification and a short horizon.” | **Talk live**, then speak the prepared request | A code-selected flock and available evidence. If labelled SAMPLE DATA, say so immediately |
| 0:55–1:20 | “Now try aggressive, keeping five wallets and clone filtering.” Then: “The preferences change the shortlist, not the frozen trading policy.” | Speak the change; stay on the visible page | Updated selection and membership changes when the selected sets differ |
| 1:20–1:55 | “The judge compares completed sentences with the facts supplied for that turn. This is a model opinion about the receipt.” | After a successful judgment, open **Audited by OpenAI Decisions**; expand **Show the call** | Full sentence, pinned facts, probabilities, measured timing, tokens and estimated cost. Banter has no verdict stamp |
| 1:55–2:20 | “Ask it about the live system, not just the list: how is it running, why this wallet, does it beat BTC?” | Speak each question; keep the page visible; point at the card that appears under the stage | **Run log** (mode, recent runs, snapshot hashes, target exposures), a **wallet drill-down** (Score evidence, pipeline score, review note) and **Backtest vs BTC**, each from the Dashboard's own data. A source that has no data shows a labelled empty card and the bird says so |
| 2:20–2:30 | “A disagreement can produce UNCLEAR. None of these stamps changes a wallet weight.” | Inspect a judged sentence in the Lens, then close it | Actual returned judgment; do not promise a particular stamp |
| 2:30–2:50 | “Even the Execute step only saves a pending simulation request for separate review.” | **End**; open **Verify**, then **Execute**. Optionally hold the confirmation control | Existing evidence if available; preview boundary. A successful save says PENDING, never an order confirmation |
| 2:50–3:00 | “Receipts check words, not markets. We have typed-turn provider evidence; real voice, sustained use and deployment need their own checks.” | Point to the footer and finish | Clear boundary between this demo and the execution pipeline |

Use `/parrot/receipts/live` for a longer sentence-feed walkthrough. Keep the local `/parrot/lab` workshop outside the production demo.

### Dashboard cards (read-only tools)

The bird has three read-only tools besides `set_strategy`: `get_run_status`, `explain_wallet` (by list position, bird name or address prefix) and `get_backtest`. The browser fetches the same public Dashboard endpoints (`/api/executor/runs`, `/status`, `/api/backend/exposures`, `/artifacts/funnel`, `/artifacts/backtest`, `/pipeline`) with GET only; code builds the facts (capped at 1200 characters) that the bird reads aloud and that the receipt judge checks. They cannot pause, resume, flatten, trade or freeze anything. Rehearse them on the presentation device: a card appears only when its endpoint returns data. In development, `/parrot?fx=1` has buttons that show each card from synthetic inputs.

### Confirm by voice (dry run, no orders)

Say "lock this in": the bird calls `request_confirmation`, and the page shows a **dry-run order sketch** (the shortlist copied at equal weights onto a flat $470 account at current prices; hypothetical, nothing is sent) while the bird reads a short summary and asks for a yes. Say "yes": the bird calls `confirm_request` and a **PENDING simulation request** is saved (status PENDING, hash on screen, an operator must review and freeze it). The on-screen **Confirm** button does the same thing as the spoken yes.

The model cannot confirm by itself: the browser saves only if the visitor's own transcript after the summary contains a clear yes (no "but", "wait", "not yet" or similar), the one-time nonce matches, it is within 90 seconds, and the strategy has not changed. Otherwise the bird says it did not hear a yes. If the selection moved between summary and yes, nothing is saved and the bird summarizes again. Real orders are not part of this page: the dry-run sketch is not the executor's plan (production weights, leverage normalization, current positions and the close-confirmation delay are not in it).

## If a service is unavailable

| Symptom / page | What appears | Presenter action |
| --- | --- | --- |
| Backend cannot supply enough stored finalists | **SAMPLE DATA** | Continue as a labelled synthetic wallet example. This badge is about wallet data; provider calls may still be real |
| `/parrot` Live is disabled, model unavailable or network fails | Failure message; **Play the cached demo** when eligible | Click it; say “hand-authored illustration.” **CACHED DEMO** has no server save; simulated confirmation is not a pending request |
| A Dashboard card says **not available / not published** | The bird said it cannot see that data; no number is invented | Say so (“that source has not published yet”) and move on; check the executor or artifact publisher afterwards |
| `/parrot` receipts never succeed in this call | Compact receipt stays hidden | Explain that judging is unavailable; voice may continue. Do not imply a hidden successful audit |
| `/parrot` receipt call fails after a success | **Receipts paused**, without a stamp or percentage | Continue voice or End; a new Talk call retries. Never substitute a fake live verdict |
| `/parrot/receipts/live` returns 503 or 429 from judging | **Receipts paused** for that voice call | End and retry after recovery; other failures mark individual sentences unavailable |
| `/parrot/receipts` judge fails, is disabled or rate-limited | **CACHED DEMO**, reason, free text disabled | Choose “Wallet A had the smaller drawdown.” and click **Judge it!**; compare with “Wallet A charged lower fees.” Cached Lens says **cached, no API call**, with no invented timing/tokens/cost. Reload after service recovery |

Rate-limit errors do not always offer cached mode. Failed provider attempts can still cost money. Details: [technical reference](../PARROT.md#receipt-guillotine).

## Honest claims

| We may say | We must not say |
| --- | --- |
| “It fact-checks completed, queued sentences against their receipt of supplied facts, within the queue limits.” | “It checks every spoken word without gaps.” Greetings, overflow and unfinished text can be skipped |
| “The grounding percentage is the judge model's opinion about support in those facts.” | “Confidence,” “accuracy,” “market correct,” or a probability of profit |
| “Code owns selection and simulation allocation; the model explains and judges.” | “The bird autonomously trades, freezes policy or manages your funds.” |
| “The Decisions API is public beta; these are recorded observations, not a service guarantee.” | “Production-proven reliability” or a promised general-availability date |
| “Existing paper-book replay is available as context.” | “This new shortlist achieved those returns.” |
| “The Lens shows validated request/response JSON and estimated input-token cost.” | “This is the complete provider bill” or “failed calls are free.” |

## Recorded measurements

Historical source: [2026-10-07 verification records](../PARROT.md#verification-record). These are not current deployment measurements.

| Check | Recorded result | Limit |
| --- | --- | --- |
| Standalone Decisions sentence check | 18 sentences; 16/18 relation classifications matched the check's expectations; latency 330–712 ms, mean 453 ms | Small observed set, not an accuracy benchmark; includes Japanese, sarcasm and two injection attempts |
| Earlier two-question receipt check | Roughly $0.00005 per call | Owner-recorded estimate in [live-specific risks](../PARROT.md#production-placement-a2--1-line); token count not verified |
| Three-question Live receipt, typed turn | 44 transcript deltas; 5 sentences judged; recorded round trip 415 ms; 822 input tokens per call; about $0.00008 per call | Silent synthetic microphone; no sustained latency distribution or total Live-session bill established |

The Live run stamped an arguably supported sentence CONTRADICTED at 42% grounding. Disclose disagreements. Costs are estimates; use the Lens for current validated calls, never for cached telemetry.

## Likely questions

| Question | Short answer |
| --- | --- |
| Does the bird trade? | No. A successful confirmation saves only a pending simulation request. Operator review and freeze are separate |
| Are these real wallets? | Check the source: SAMPLE DATA is synthetic; live finalists come from stored pipeline accounts. Neither means a fresh exchange fetch for each turn |
| What does MATCHES mean? | The model judges the sentence supported by that receipt. It does not establish that the receipt is market truth |
| Why can two checks disagree? | Fact support and relation are separate model answers. `settle` maps contradictory answers to UNCLEAR |
| Is the judge independent financial review? | No. It is an additional model call comparing words with supplied facts, outside the allocation/execution path |
| Is everything sent to OpenAI? | Live voice is processed there; receipts send the sentence and its turn facts. The standalone page sends the typed claim and fixed sample receipt |
| Can we inspect the evidence? | Yes: open the Lens for the full sentence, its pinned facts and exact validated JSON. It does not expose the API key |
| Did you test real voice? | The recorded provider tests used typed turns and a silent synthetic microphone. Real spoken audio and microphone acceptance are not verified |

## Known limits

Sentence splitting is heuristic; transcript arrival is not audio playback timing. Queue caps can skip sentences, and End discards unfinished text. Public facts mode accepts caller-supplied text without attesting provenance. Prompt-injection resistance is not guaranteed. The browser countdown is not a server billing cap, and backend-model cost can exceed its allowance. Sustained judging, noisy speech, broader language behavior, phone layout/audio and deployed operation remain separate acceptance work; see [residual risks](../PARROT.md#residual-risks-and-unverified-items).

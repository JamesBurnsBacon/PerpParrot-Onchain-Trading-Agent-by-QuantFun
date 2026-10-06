# Talk to the Parrot

`/parrot` is a voice-first demo page: a visitor talks to an animated clay parrot (OpenAI GPT-Live), and the parrot turns the conversation into a
**bounded strategy** that code checks, shortlists wallets for, and can save as a **pending request**. It sits **outside** the 10-minute trading loop
and has no trading authority.

```
visitor voice ──WebRTC──► GPT-Live (gpt-live-1) ──delegates──► backend model (gpt-5.6-terra)
                                                                   │ may call ONE tool: set_strategy
browser ◄── facts + result ◄── POST /live/strategy (our code: validate → clamp → shortlist) ◄──┘
browser ── hold to confirm ──► POST /chat/preview ──► PENDING request (hash). An operator must still review and freeze.
```

## What it can and cannot do

- **Can:** hear a strategy idea, map it to enums and bounded numbers (`StrategyIntent`), show the policy changes, clamps and a wallet shortlist,
  explain them in the parrot's voice, and save a pending request.
- **Cannot:** place orders, hold keys, freeze or change a frozen configuration, call `/reports`, or read admin tokens. The code under `packages/backend/src/chat`
  and `src/live` references none of `ADMIN_TOKEN`, `HL_API_WALLET_KEY`, `CRE_API_KEY`.
- **The model never allocates.** `intentToPreview` can only tighten the base policy (a request for 100x becomes the policy cap). Every style produces a **simulation preview**; an operator must review and freeze separately. Only code builds the facts the parrot speaks. Visitor text and model prose never enter state or the prompt as facts.
- **Honest labels.** The finalists are currently **sample data** (`SAMPLE DATA` badge). Nothing on the page is a forecast or a signed report.

## Strategy contract

`packages/shared/strategy-intent.ts` is the team's single source for `StrategyIntent`, validation, `intentToPreview` and `shortlist`. `packages/backend/src/strategy-intent-adapter.ts` maps real Score outputs to that contract; Parrot does not alter either module. Diversification and leverage comfort use `low | medium | high`.

The policy summary is `{ changes, clamps, requiredSources, maxSources }`: the source limit is the visitor's maximum, and the UI/facts state "needs at least N". Infeasible limits return HTTP 422 without raising that maximum. Text-chat clarification returns reply, clarify, intent, model and latency, without policy or shortlist. Every saved PENDING preview contains the compiled SIMULATION policy, rounds cash up to millionths, and has exact integer allocation totals. The deterministic hash retains the `perpparrot:parrot-preview:v1` domain; it never grants execution authority.

## Endpoints

| Route | Purpose | Switch |
| --- | --- | --- |
| `POST /live/session` | Exchange the browser's SDP for a GPT-Live session. The session config (model, voice, prompts, tools, delegation) is **server-owned**; the body is `{sdp}` only | `LIVE_ENABLED=true` |
| `POST /live/strategy` | Body `{ intent, previous? }`: optional `previous` is up to 25 distinct known finalist ids. Unknown keys/ids are rejected. Validate, clamp, shortlist, return code-built facts. No model call | `LIVE_ENABLED=true` |
| `POST /chat`, `POST /chat/preview` | Text intent extraction (strict JSON schema) and the pending-request preview | `CHAT_ENABLED=true` |

Both switches are **off by default** and independent. Turn Live on only for recording and judging.
Run migrations in order: `20261006140000_chat.sql`, then `20261007000000_live_usage.sql`.

## Environment

Reused: `OPENAI_API_KEY`, `CHAT_IP_SALT`, `CHAT_DAILY_BUDGET_USD` (default 5, shared by chat and Live), `CHAT_PREVIEW_IP_HOURLY_LIMIT`.
Chat: `CHAT_MODEL` (gpt-5.4-mini), `CHAT_IP_HOURLY_LIMIT` (10), `CHAT_GLOBAL_DAILY_LIMIT` (100), `CHAT_PREVIEW_GLOBAL_DAILY_LIMIT` (500; invalid values use default), `CHAT_PRICE_IN_PER_M_USD` (1), `CHAT_PRICE_OUT_PER_M_USD` (4).

| Live variable | Default |
| --- | --- |
| `LIVE_ENABLED` | off (only the literal `true` enables it) |
| `LIVE_MODEL` / `LIVE_BACKEND_MODEL` | `gpt-live-1` / `gpt-5.6-terra` |
| `LIVE_VOICE` | `gleam` (any built-in voice name) |
| `LIVE_BACKEND_REASONING` | `medium` |
| `LIVE_MAX_SESSION_SECONDS` | 180 (browser countdown; 1–900) |
| `LIVE_IP_HOURLY_LIMIT` / `LIVE_GLOBAL_DAILY_LIMIT` | 3 / 30 sessions |
| `LIVE_VOICE_PRICE_PER_MIN_USD` / `LIVE_BACKEND_ALLOWANCE_USD` | 0.05 / 0.15 (reservation per session) |

Invalid optional values fall back to the defaults and never block startup. On Vercel the key and switches must be added by someone with team access
(interactive masked prompt, after confirming the project and environment scope); they are not read from GitHub Actions secrets.

## Safety controls

- **The browser is untrusted.** The session is created with `client.data_channel.allowed_client_events = [response.item.create, response.create, session.close]`;
  verified against the real API: `session.update` and `session.*.append` from the data channel return `event_not_allowed`. The browser cannot change the model, prompts, tools or delegation.
- Per-IP hourly and global daily session limits, a reserved cost per session against a shared daily budget (Postgres advisory-lock limiter), 429 with `retryAfterSec`.
  A definite 4xx from OpenAI releases the cost; 5xx, timeouts and invalid bodies keep it. Upstream bodies are never echoed to clients; the key never reaches the browser.
- The microphone is closed on End, on Cancel while connecting, on tab hidden, on error and when the countdown ends. If a strategy update is unfinished when the call ends,
  the page clears the plan instead of leaving a stale, confirmable one.
- Text from the model or transcripts is rendered only as React text; the page shows no live transcript.

## Residual risks (known, accepted for a time-boxed demo)

1. **Call duration is enforced by the browser only.** The API offers no server-side duration setting; the platform has its own limit (`expired`). A modified client can keep a session
   longer than 180 s. Mitigations: Live is off except during recording/judging, session counts are capped, and **set a spend limit on the OpenAI key**.
2. **Backend-model cost per session is not capped.** A modified client can ask for many strategy changes in one call. Each is a short model call, comparable to the voice cost per minute; the key's spend limit is the backstop.
3. **Client IP.** Limits key on the first `x-forwarded-for` value. On Vercel the platform sets it; behind any other ingress, verify it cannot be spoofed before enabling Live publicly.

## Run locally

Backend (from `packages/backend`, memory stores, no database needed):

```
CONFIGURATION_PATH=fixtures/frozen-configuration.json FROZEN_CONFIGURATION_HASH=<configurationHash of that file> \
CHAT_ENABLED=true LIVE_ENABLED=true OPENAI_API_KEY=… PORT=8788 bun run src/server.ts
```

Dashboard (from `packages/dashboard`): `bun run dev` (its dev rewrite sends `/api/backend` to `localhost:8788`). Open `/parrot` in Chrome and allow the microphone.

## Offline contract migration (2026-10-07)

The recorded Live event fixture is a protocol replay adapted from the earlier recording: its enum spelling is migrated to `medium`. This is not a new real-provider verification. The real-model evaluation script imports the team schema; Claude will rerun it, Postgres tests and Linux checks separately. No network was used for this migration.

## Earlier verification record (2026-10-06)

- Real API, text-driven through the real WebRTC protocol: session creation (201), delegated `set_strategy` call, clamp 100x → 3x, spoken explanation grounded in the facts,
  `event_not_allowed` for browser reconfiguration, 429 after the per-IP limit, normal and requested close with usage.
- Offline: backend suite against a real Postgres 16 (701 tests), recorded real GPT-Live events replayed through the event reducer, mutation controls for the limiter, kill switch, body validation and config forwarding.
- **Not verified:** live microphone calls and voice quality in a browser, a deployment on Vercel, and the default Turbopack build (the webpack build passes).

## Wallet board

The wallet board uses 40 deterministic synthetic finalists. Their fake `0x` + 40 hex addresses are SHA-256(seed:index) prefixes, generated with seed 20261006 by `scripts/make-sample-finalists.ts`; no venue accounts are fetched. Cards show shortened ids such as `0x1234...abcd` beside nicknames. The generated shared id registry keeps nickname collision resolution independent of the current selection. Evidence includes original Score rank, rounded risk metrics and fixed code tags; `changes` explains membership against `previous`. Spoken facts include at most three wallets per side, stay within 1200 characters and retain the no-orders statement. Conservative selection calls the team shortlist with `M = min(25, ceil(1.2 * N))`, an intent maximum of M, then takes N; the team function uses its fixed top-2M score window. Other styles call it directly with N; Score is unchanged, and pending previews use the same selector. Reels, feathers and sound celebrate strategy selection or a pending request, never gains. SAMPLE DATA stays visible; Calm/reduced motion keep static states, and visitor speech suppresses effects.

“The Flock” shows three bird tiles per row: an inline clay bird, a deterministic nickname, a muted wallet id and one three-zone meter. Tap or keyboard-activate a tile to expand its original Score rank, exact supplied risk metrics, server tags and change reason. NEW! and Bye! stickers mark additions and ~2.5-second removal ghosts; kept birds do not roll again. The initial/connecting board says “Waiting for birds...”.

`packages/shared/wallet-persona.ts` is presentation-only and has no backend/dashboard imports. It supplies the same nickname to cards and spoken added/removed facts. Hash collisions are resolved over the fixed 40-id sample universe, keeping all sample names unique and stable across selection changes; the six cached-demo identities are similarly stable and unique. Arbitrary future ids use a stable hash fallback and can collide with the finite name vocabulary. Evidence uses Score’s native non-annualised `realizedVol`. Vibe uses fractional evidence: Calm requires drawdown <15% AND realized volatility <45%; Wild requires drawdown ≥30% OR volatility ≥80%; otherwise Steady. Missing/invalid either metric is neutral Steady. These buckets have no policy, Score or trading authority.

Offline implementation evidence and full pairwise measurements: [Wallet board verification](WALLET-BOARD-VERIFICATION.md).

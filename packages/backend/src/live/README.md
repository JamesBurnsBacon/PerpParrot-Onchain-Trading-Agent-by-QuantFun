# Talk live

`LIVE_ENABLED=true` enables `/live/session` and `/live/strategy`. The default is off. The chat switch is independent. No Live route saves a pending request, changes a frozen configuration, or places an order.

Session settings are built by `config.ts`; the browser submits only SDP. The one strict Responses function returns bounded preferences to `/live/strategy`, which validates them and uses the shared selection pipeline. Only code-built facts go back as the function output. Chat and Live share the same limiter instance, Postgres advisory lock and daily budget, with separate per-kind request counts. Apply `20261007000000_live_usage.sql` after the chat migration.

| Environment | Default |
| --- | --- |
| LIVE_ENABLED | false (only literal `true` enables it) |
| LIVE_MODEL | gpt-live-1 |
| LIVE_VOICE | gleam (North American, feminine; others: see the voice audition) |
| LIVE_BACKEND_MODEL | gpt-5.6-terra |
| LIVE_BACKEND_REASONING | medium |
| LIVE_MAX_SESSION_SECONDS | 180 (integer 1–900) |
| LIVE_IP_HOURLY_LIMIT | 3 |
| LIVE_GLOBAL_DAILY_LIMIT | 30 |
| LIVE_VOICE_PRICE_PER_MIN_USD | 0.05 |
| LIVE_BACKEND_ALLOWANCE_USD | 0.15 |

Reuses `OPENAI_API_KEY`, `CHAT_IP_SALT` (default `perpparrot-chat-v1`), `CHAT_DAILY_BUDGET_USD` (default 5), and the preview hourly limit for strategy calls. Invalid optional numeric settings fall back. Reservations remain after successful creation or ambiguous outcomes; definite HTTP rejection releases cost but retains the request count.

## Local documentation decisions and verification boundary

The supplied `live-conversations.md` specifies `audio.output.voice`, with lowercase `gleam`. No WebRTC audio format is sent. `voice-latency-cost.md` explicitly credits the 15-second initialization against running time: reserve `max(15, maxSessionSeconds) / 60 * voicePrice + backendAllowance`, rather than adding it twice. The default reservation is $0.30. It is an estimate, not an authoritative usage record.

The supplied guides mention frontend client permissions but do not document their field names or defaults. They also expose no server-side duration/idle setting. This implementation never sends client configuration commands and rejects configuration in HTTP bodies, but API-level rejection of a malicious browser's `session.update` cannot be established from those guides. Duration is currently enforced by the browser countdown; it is not an untamperable server billing cap. Obtain the missing API reference and verify/enforce data-channel permissions before enabling public sessions. Do not invent API fields to claim those protections. The safety-identifier header is documented only in the Realtime section, so it is omitted for Live.

No network/API/audio/browser verification was performed. Offline verification uses injected fetches, bounded event tests, a PGlite migration check, and the existing optional real-Postgres suite (`TEST_DATABASE_URL`). Run `bun test` and `bun run typecheck` from `packages/backend`; run `bunx tsc --noEmit && bun run build` from `packages/dashboard`.

`bun packages/backend/test/live-mutations.ts` executes five mutations in disposable copies and verifies a named guard test fails for each, followed by a restored-green baseline. Copies are used because this workspace sandbox refuses writes to the worktree's shared Git index. No commits or pushes were possible here. Docker access and native Postgres shared memory were also denied. The default Turbopack build was denied an internal port bind; `bun run build --webpack` succeeded without changing build configuration. Real Postgres 16, default-build acceptance, browser layout/microphone lifecycle, and real GPT-Live behavior remain for independent verification.

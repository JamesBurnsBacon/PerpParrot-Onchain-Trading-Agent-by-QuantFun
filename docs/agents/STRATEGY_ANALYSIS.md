# Advisory strategy analysis

After the ten-minute pick, the backend queues one analysis for its 25 finalists.
This is a separate research note beside the existing committee verdict. It cannot
change selection, weights, configuration, approval or orders (`economicAuthority: false`).

## Data and output

`selection_runs` supplies the picked addresses, kinds, ranks, scores and metrics.
`pipeline_accounts` supplies portfolio history, account value and the existing fill
statistics. These inputs are frozen when queued; their observation times are retained.
Older selections may lack metrics; missing values remain unknown. Catch-up freezes
the data available then, not a reconstruction of the original selection snapshot.

The worker reads current positions on core (`""`) and `xyz`, 50 lightweight state
queries for 25 finalists. It does not re-fetch fills or portfolio history. It sends
anonymous candidate IDs, at most 48 month PnL points and the largest 12 positions
per candidate to one OpenAI Responses request. PnL is cumulative dollars, not NAV
or deposit-adjusted return. Position times can be later than the selection time.
State reads use main's provider router: official by default, with the existing
optional NOWNodes failover settings respected.

Crypto, gold and oil are explicitly assessed. All observed positions contribute to
class totals before the 12-position detail cap:

| Class | Symbol mapping |
|---|---|
| Gold | `PAXG`, `xyz:GOLD` |
| Oil | `xyz:CL` (WTI), `xyz:BRENTOIL` (Brent) |
| Crypto | Other core symbols without a dex prefix |
| Other | Unclassified HIP-3 symbols; never assumed to be crypto |

Mappings were checked against Hyperliquid `meta` on 2026-10-07. New listings may need
classification changes. Other dexes, spot holdings and off-platform hedges are not
inspected. No position means “not observed in this scope”, not “never traded it”.
Account-wide history cannot establish per-asset performance or entry/exit rules.

Each finalist receives an English strategy hypothesis, confidence, evidence,
risks and unknowns. Every evidence reference must exactly match a non-null input
value. Schema and ID checks reject missing/duplicate candidates or extra fields.
This validates citations, not the truth of the model's interpretation.
Input hashes use SHA-256 over JSON with recursively sorted object keys so they
remain reproducible after Postgres JSONB reorders keys; arrays retain their order.

## Deploy and operate

1. After the pipeline migrations (including `20261007160000_pipeline_primary.sql`), apply
   `supabase/migrations/20261007170000_strategy_analyses.sql`. It is additive and
   safe to run twice. Do not reset the shared database.
2. Use the existing server-only `DATABASE_URL`, `CRON_SECRET`, `ADMIN_TOKEN` and
   `OPENAI_API_KEY`. Optional `OPENAI_STRATEGY_MODEL` defaults to `gpt-6-astra` with
   high reasoning. API billing is separate from ChatGPT/Codex credits.
3. Deploy. `/cron/pipeline/agent` runs at `:08, :18, :28, :38, :48, :58`, after the
   pick at `:x4`. An operator can use `POST /admin/pipeline/agent` with the existing
   admin bearer token. Missing key leaves work queued without model calls.
4. Inspect `GET /pipeline` → `latest.strategy` and the dashboard's finalist rows.
   The private table retains input, hashes, model, prompt version, token usage,
   provider IDs and completion time; the public projection contains only notes
   and display metadata. It exposes no raw input or provider credentials.

The sorted address-set hash is unique: unchanged/reordered picks, forced selection
and a later return to an already analysed set reuse that set's original result.
The displayed completion time matters: a reused note is not a fresh market update.
The original selection-run FK remains attached to that analysis.

`FOR UPDATE SKIP LOCKED` and a claim token prevent duplicate workers. The worker
has a 650-second deadline and a 15-minute lease. It catches up the latest 20
selection runs after a missed enqueue. Failures and expired claims remain visible;
there is no automatic paid retry because a timed-out call may already be billed.
Investigate private row status/provider IDs before an explicit operator retry.
Input/response sizes are bounded and OpenAI storage is disabled (`store: false`).

Queue regression: `cd packages/backend && bun test test/strategy-agent.test.ts`.
It uses PGlite with the real migrations and SQL, a mocked provider, overlapping
workers, duplicate picks, missing keys, expired workers and invalid evidence.
Generated rehearsal data stays local under ignored `work/`; none belongs in Git.

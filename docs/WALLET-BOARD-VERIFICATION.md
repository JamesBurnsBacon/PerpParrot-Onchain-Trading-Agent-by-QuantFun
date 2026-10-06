# Wallet board verification — 2026-10-07

Offline verification of the migration to the team's StrategyIntent contract. No network, provider session, database or browser interaction was used.

## Contract and selection

`packages/shared/strategy-intent.ts` is the single source for intent validation, simulation policy compilation and style ordering. It, the backend Score adapter and `backend/test/strategy-intent.test.ts` are byte-for-byte unchanged. The duplicate Parrot module and its test have been removed; a regression test checks absence and imports across tracked and untracked package sources. Local main was already an ancestor of this branch; no fetch or history rewrite was needed.

Parrot projects its sample rows to the seven contract fields before calling the team shortlist: display metadata is not accepted by that strict API. All previews are SIMULATION, with separate operator review and freeze. Policy summaries expose changes, clamps, requiredSources and the requested maxSources. A conservative five-source request that needs six returns 422 instead of expanding the maximum. Text-chat clarification, including an empty non-null question, returns no policy or shortlist and never invokes the candidate loader.

40 synthetic rows: 36 generated equity paths run through unchanged Score, including eight clone copies, plus four exclusion controls. Seed 20261006. Fake addresses are the first 40 hex characters of SHA-256(seed:index), prefixed with `0x`; every row/response retains `dataSource: "sample"` and the UI retains SAMPLE DATA. The fixture generator also writes the presentation-only shared id registry. All 40 sample nicknames are unique and stable; arbitrary future ids can collide in the finite name vocabulary.

Evidence now uses Score's native **non-annualised realizedVol**, not an annualised statistic. The board shows a shortened address and deterministic nickname, original Score rank, rounded supplied risk metrics, code-owned tags and membership-change reasons. Unknown clone status is excluded when avoidClones is enabled. Spoken facts keep nicknames, at most three wallets per side, a 1200-character ceiling and the no-orders/operator-freeze statement.

The team's conservative ordering uses the top 2N by score. Parrot alone widens its call to `M = min(25, ceil(1.2 * N))`, passes maxSources M in the intent, then takes N. Other styles call the team shortlist directly with N. Two calm wallets still enter when moving from aggressive fourteen to conservative six. Saved PENDING previews use this same selector and order.

## Measured swaps

Rerun: `bun packages/backend/scripts/measure-wallet-board.ts`.

- safe/few: 6; balanced: 12; aggressive/many: 14; all remaining requests: 12.
- safe/few ↔ balanced: **33%**; safe/few ↔ aggressive/many: **60%**.
- balanced ↔ aggressive/many: **46%**; clones on ↔ off: **42%**.
- aggressive/many ↔ clones/on: **62%**, slightly above the rough 30–60% target.
- Diversification and leverage alone change policy, so their membership turnover remains **0%**. No extra sample tuning was needed for this migration.

Turnover is `(added + removed) / (before size + after size)`, not a return/performance measure. Full pairwise results:

```text
from -> to: kept / in / out; turnover = (in + out) / (before + after)
safe/few -> balanced: 6 / 6 / 0; 33%
safe/few -> aggressive/many: 4 / 10 / 2; 60%
safe/few -> clones/on: 6 / 6 / 0; 33%
safe/few -> clones/off: 6 / 6 / 0; 33%
safe/few -> diverse: 6 / 6 / 0; 33%
safe/few -> low leverage: 6 / 6 / 0; 33%
safe/few -> clamped: 6 / 6 / 0; 33%
balanced -> aggressive/many: 7 / 7 / 5; 46%
balanced -> clones/on: 7 / 5 / 5; 42%
balanced -> clones/off: 12 / 0 / 0; 0%
balanced -> diverse: 12 / 0 / 0; 0%
balanced -> low leverage: 12 / 0 / 0; 0%
balanced -> clamped: 12 / 0 / 0; 0%
aggressive/many -> clones/on: 5 / 7 / 9; 62%
aggressive/many -> clones/off: 7 / 5 / 7; 46%
aggressive/many -> diverse: 7 / 5 / 7; 46%
aggressive/many -> low leverage: 7 / 5 / 7; 46%
aggressive/many -> clamped: 7 / 5 / 7; 46%
clones/on -> clones/off: 7 / 5 / 5; 42%
clones/on -> diverse: 7 / 5 / 5; 42%
clones/on -> low leverage: 7 / 5 / 5; 42%
clones/on -> clamped: 7 / 5 / 5; 42%
clones/off -> diverse: 12 / 0 / 0; 0%
clones/off -> low leverage: 12 / 0 / 0; 0%
clones/off -> clamped: 12 / 0 / 0; 0%
diverse -> low leverage: 12 / 0 / 0; 0%
diverse -> clamped: 12 / 0 / 0; 0%
low leverage -> clamped: 12 / 0 / 0; 0%
```

## Verification

- Backend `bunx tsc --noEmit && bun test`: **608 pass / 20 skip / 0 fail**. TEST_DATABASE_URL is unset; Postgres and Linux checks remain for Claude.
- Dashboard `bunx tsc --noEmit && bun test`: **7 pass / 0 fail**. React render tests remain in `packages/dashboard/test`; backend tests do not need React.
- `bun run build`: Turbopack's CSS subprocess could not bind a local port (`Operation not permitted`). `NEXT_TELEMETRY_DISABLED=1 bun run build --webpack`: passed, including static `/parrot` generation.
- Prompt is 1499 characters (existing 1500-character bound); fixed prompt-hash checks and medium/simulation behavior assertions pass. The real-model eval script imports the team contract; it was not run offline.
- Parrot integration tests cover policy cap clamps, tighter base limits across styles, source feasibility → HTTP 422, cash rounding upward, exact allocation totals, stable hashes/domain, contract field projection, conservative window, unknown clone reasons, and exact displayed/saved membership. The team's own compiler/shortlist coverage replaces the deleted duplicate contract tests.
- Cached demos use SIMULATION, matching policy fields/source requirements and millionth allocation totals. UI guards distinguish clarification responses from selectable plans and reject non-simulation previews.
- Existing no-authority, limiter, Live protocol and CI-related tests remain. Live config structure, persona, allowed client events, limits, CI workflows and dependencies are unchanged; prompt wording now states simulation semantics. The recorded event replay's enum spelling was migrated to medium; this is not a new provider recording.
- `git diff --check` and SHA-256 checks of all three protected files pass.
- Git staging failed creating the external worktree `index.lock` (`Operation not permitted`); all changes remain uncommitted.

The requested legacy-term scan has two intentional existing documentation hits: `docs/agents/PAPER_LIFECYCLE.md:30` describes the separate paper lifecycle's pause authority, and `docs/cre/INTEGRATION.md:17` describes the retired mirror spike. The new `parrot-contract.test.ts` deliberately names the deleted module to prevent its return; it never imports it. No obsolete fields, enum spellings or eligibility labels remain in Parrot product code/docs.

## Not verified here

Real-model intent quality, microphone/provider E2E, Postgres persistence, Linux, deployment and funded behavior remain unverified. Render assertions do not prove browser layout, native detail interaction/focus, screen-reader announcements, motion/ghost timing, reduced motion, sound or visual photosensitivity. These still need device/browser checks. No trading authority is created by this work.

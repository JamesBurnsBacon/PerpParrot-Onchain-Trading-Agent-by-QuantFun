# Wallet board verification — 2026-10-07

Offline synthetic membership measurements. No provider session, database or browser interaction is established by these results. Current architecture, invariants, verification commands and the dated verification record are in [PARROT.md](PARROT.md).

## Contract and selection

`packages/shared/strategy-intent.ts` is the shared intent/shortlist contract. Parrot reads it and the backend Score adapter without changing either; it does not use the shared policy-tightening compiler. A source-scan regression test prevents the duplicate Parrot intent module from returning.

Parrot projects finalist rows to the seven candidate contract fields before calling the shared shortlist; display metadata is not accepted by that strict API. Only risk style, requested source count and clone filtering shape membership. Diversification, leverage comfort, horizon and requested leverage are context only. Policy summaries retain `{ changes: [], clamps: [], maxSources }` for response compatibility. A saved pending request copies the base policy in SIMULATION with `approvalRequired: true`; an infeasible allocation returns 422 without rewriting the policy or source limit. Clarification responses contain neither policy nor shortlist and do not load candidates.

The measurements below use 40 synthetic rows: 36 generated equity paths run through unchanged Score (including eight clone copies) and four exclusion controls, seed 20261006. Fake addresses use the first 40 hex characters of SHA-256(seed:index), prefixed with `0x`. The generated registry keeps all 40 sample nicknames stable and unique; arbitrary live ids may collide. Sample responses retain `dataSource: "sample"` and SAMPLE DATA. Normal operation can instead read live Score finalists from stored pipeline accounts; only sample and cached-demo data receive badges.

Evidence uses Score's native, non-annualised `realizedVol`. Tiles show shortened addresses, deterministic names, original rank, rounded supplied metrics, code-owned tags and membership reasons. Unknown clone status is excluded when `avoidClones` is true. Spoken membership facts retain nicknames, at most three wallets per side, the 1200-character bound and the no-orders/operator-review statement.

Conservative ordering uses a widened shared-shortlist call: `M = min(25, ceil(1.2 * N))`, top-2M Score window, then N results. Other styles call the shared shortlist directly with N. Two calm wallets enter when switching from aggressive fourteen to conservative six. Saved PENDING previews use this same selector and order.

## Measured swaps

Rerun: `bun packages/backend/scripts/measure-wallet-board.ts`.

- safe/few: 6; balanced: 12; aggressive/many: 14; all remaining requests: 12.
- safe/few ↔ balanced: **33%**; safe/few ↔ aggressive/many: **60%**.
- balanced ↔ aggressive/many: **46%**; clones on ↔ off: **42%**.
- aggressive/many ↔ clones/on: **62%**, slightly above the rough 30–60% target.
- Diversification and leverage are context only, so their membership turnover remains **0%**. These values measure the fixed synthetic fixture.

Turnover is `(added + removed) / (before size + after size)`, not a return/performance measure. Full pairwise results:

```text
from -> to: kept / in / out; turnover = (in + out) / (before + after)
safe/few -> balanced: 6 / 6 / 0; 33%
safe/few -> aggressive/many: 4 / 10 / 2; 60%
safe/few -> clones/on: 6 / 6 / 0; 33%
safe/few -> clones/off: 6 / 6 / 0; 33%
safe/few -> diverse: 6 / 6 / 0; 33%
safe/few -> low leverage: 6 / 6 / 0; 33%
safe/few -> requestedLeverage: 6 / 6 / 0; 33%
balanced -> aggressive/many: 7 / 7 / 5; 46%
balanced -> clones/on: 7 / 5 / 5; 42%
balanced -> clones/off: 12 / 0 / 0; 0%
balanced -> diverse: 12 / 0 / 0; 0%
balanced -> low leverage: 12 / 0 / 0; 0%
balanced -> requestedLeverage: 12 / 0 / 0; 0%
aggressive/many -> clones/on: 5 / 7 / 9; 62%
aggressive/many -> clones/off: 7 / 5 / 7; 46%
aggressive/many -> diverse: 7 / 5 / 7; 46%
aggressive/many -> low leverage: 7 / 5 / 7; 46%
aggressive/many -> requestedLeverage: 7 / 5 / 7; 46%
clones/on -> clones/off: 7 / 5 / 5; 42%
clones/on -> diverse: 7 / 5 / 5; 42%
clones/on -> low leverage: 7 / 5 / 5; 42%
clones/on -> requestedLeverage: 7 / 5 / 5; 42%
clones/off -> diverse: 12 / 0 / 0; 0%
clones/off -> low leverage: 12 / 0 / 0; 0%
clones/off -> requestedLeverage: 12 / 0 / 0; 0%
diverse -> low leverage: 12 / 0 / 0; 0%
diverse -> requestedLeverage: 12 / 0 / 0; 0%
low leverage -> requestedLeverage: 12 / 0 / 0; 0%
```

## Verification scope

The pairwise counts and percentages above are preserved; `requestedLeverage` names the 100x context-only scenario. These are membership changes, not returns or policy changes.

The current suites cover unchanged base-policy previews, infeasible allocations, cash rounding, exact totals and hashes, contract projection, the conservative window, unknown clone reasons and displayed/saved membership. Browser guards reject non-simulation previews and nonempty policy adjustment arrays. The no-authority scan, prompt text, session event allowlist, limits and sound mapping are unchanged by the documentation/refactor work.

Developer mutation scripts live in `packages/backend/scripts/` and are not `bun test` entry points. The board script checks scheduler behavior in disposable copies; the context script checks address deduplication, read failure isolation and the facts-length limit. Both require assertion failures under mutation, GREEN restoration and matching SHA-256 hashes. See [the verification record](PARROT.md#verification-record) for current package totals and production-bundle evidence.

## Not verified here

Real-model intent quality, browser microphone/provider E2E, Postgres persistence without `TEST_DATABASE_URL`, Linux and deployment remain unverified. Render assertions do not prove layout, native detail interaction/focus, screen-reader announcements, motion/ghost timing, reduced motion, sound or visual photosensitivity. Real Hyperliquid finalists and the sample-calibrated vibe thresholds still need live inspection. None of this evidence grants trading authority.

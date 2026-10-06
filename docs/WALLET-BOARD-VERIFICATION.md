# Wallet board verification — 2026-10-06

Offline worktree verification; no screen, speakers, network, provider session or database was used.

## Flock tile simplification — current verification

The Flock now uses inline bird SVGs with three evidence-derived moods, shared deterministic nicknames, one three-zone meter, native expandable evidence, NEW!/Bye! stickers and three columns at every viewport size. Kept tiles have no reel or entry animation. Ghost expiry remains 2500 ms; Calm and reduced motion keep static stickers. The board precedes the policy controls in Select, and the empty/connecting state is one line. No selection, Score, protected strategy-intent file, dependency, execution, provider or sound-hook code changed.

Pure logic lives in `packages/shared/wallet-persona.ts` and is re-exported by dashboard `lib/wallet-board.ts`. All 40 sample identities have distinct stable names, as do all six cached identities; arbitrary future ids may collide in the finite vocabulary. Backend facts use that same function. Exact thresholds and the missing-evidence Steady fallback are documented beside the function and in PARROT.md.

Verification on this change:

- Dashboard `bunx tsc --noEmit && bun test`: passed, **7 pass / 0 fail**.
- Backend `bunx tsc --noEmit && bun test`: passed, **795 pass / 20 skip / 0 fail**. `TEST_DATABASE_URL` was unset for offline verification; real DB checks remain for Claude.
- `bun run build`: Turbopack failed while processing CSS because its process could not bind a local port (`Operation not permitted`). `NEXT_TELEMETRY_DISABLED=1 bun run build --webpack`: passed, including static `/parrot` generation.
- `git diff --check`: passed. Git staging was denied at the external worktree `index.lock`; changes remain uncommitted.
- The only changed existing test is `backend/test/wallet-board.test.ts`: facts now assert the shared nickname and count parenthesized wallet ids rather than the old parenthesized reasons. No existing DOM tests asserted the old card face. New render tests stay under `dashboard/test/wallet-board-render.test.tsx`; backend tests/scripts have no React dependency.

Red/green proof: the new logic/render tests initially failed on absent exports. With persona logic added but the old facts builder retained, the facts assertion failed on the missing nickname. The reproducible pure negative controls (`bun packages/backend/scripts/check-wallet-persona-mutations.ts`, run alone) then produced **12 assertion failures**, one per removed behavior, followed by **15 passing tests** with sources restored:

```text
RED: calm drawdown boundary (1 fail)
RED: calm volatility boundary (1 fail)
RED: wild drawdown boundary (1 fail)
RED: wild volatility boundary (1 fail)
RED: missing evidence neutrality (2 fail)
RED: nickname determinism (1 fail)
RED: nickname uniqueness (1 fail)
RED: nickname vocabulary safety (1 fail)
RED: board identity diff (1 fail)
RED: spoken nicknames (1 fail)
RED: facts length budget (1 fail)
RED: accessible change label (1 fail)
GREEN: restored sources; 15 pass
```

Render assertions verify closed details, exact supplied percentages and server text, one face bird/meter in static mode, removal of old face labels, accessible names, static stickers, no reels on kept birds, cached-data fallback, SAMPLE DATA, waiting text and the hidden live region. These are markup checks, not browser interaction tests.

**Still unverified visually/on-device:** desktop and 375 px sizing/no horizontal scroll; nickname wrapping and meter legibility; mood recognition and clay appearance; both themes and contrast; bounce/reels, wave/ghost collapse and rapid reentry; native detail toggling and visible focus; screen-reader announcements; reduced-motion/Calm transitions; sound and real microphone/provider behavior. The earlier verification below describes the preceding board implementation, not these new visuals.

## Selection and fixture

40 synthetic rows: 36 generated price/equity paths run through the existing Score implementation, including eight deliberate clone copies; four explicit exclusion controls. Fixed seed 20261006. Every row and response is labelled sample. No Score code or shared strategy-intent source changed.

With the richer data alone, conservative six remained a subset of aggressive fourteen: there were no incoming cards when asking for safety. The backend now widens the conservative score window from `2 × N` to `2 × min(25, ceil(1.2 × N))`, then uses the same volatility ordering and takes N. This produces two incoming calm wallets when switching aggressive/many to safe/few. Balanced and aggressive selection remain unchanged. Preview creation now uses this same selector, so the saved PENDING sources match the displayed list exactly (regression demonstrated red before the preview-path fix).

Diversification/leverage continue to tighten policy, not fabricate per-wallet exposure information: their membership-only comparisons are zero. Turnover below means `(added + removed) / (before size + after size)`, not a return or performance measure.

Run `bun packages/backend/scripts/measure-wallet-board.ts`:

```text
safe/few: 6 [addr-18, addr-06, addr-15, addr-09, addr-03, addr-17]
balanced: 12 [addr-03, addr-21, addr-06, addr-15, addr-24, addr-09, addr-12, addr-18, addr-02, addr-17, addr-23, addr-08]
aggressive/many: 14 [addr-01, addr-23, addr-06, addr-15, addr-26, addr-07, addr-03, addr-28, addr-16, addr-08, addr-19, addr-17, addr-14, addr-02]
clones/on: 12 [addr-03, addr-29, addr-06, addr-30, addr-15, addr-31, addr-09, addr-32, addr-18, addr-33, addr-02, addr-17]
clones/off: 12 [addr-03, addr-21, addr-06, addr-15, addr-24, addr-09, addr-12, addr-18, addr-02, addr-17, addr-23, addr-08]
diverse: 12 [addr-03, addr-21, addr-06, addr-15, addr-24, addr-09, addr-12, addr-18, addr-02, addr-17, addr-23, addr-08]
low leverage: 12 [addr-03, addr-21, addr-06, addr-15, addr-24, addr-09, addr-12, addr-18, addr-02, addr-17, addr-23, addr-08]
clamped: 12 [addr-03, addr-21, addr-06, addr-15, addr-24, addr-09, addr-12, addr-18, addr-02, addr-17, addr-23, addr-08]
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

## Negative controls

New tests failed before implementation. The reproducible script `bun packages/backend/scripts/check-wallet-board-mutations.ts` additionally removes one fix at a time, requires a failing assertion, and restores the file in `finally`. Run it alone; it temporarily edits source. Final observed output:

```text
RED: reason consistency (1 fail)
RED: style priority reason (1 fail)
RED: previous unknown id (1 fail)
RED: previous oversize (1 fail)
RED: previous unknown keys (1 fail)
RED: facts per-side cap (2 fail)
RED: facts length (1 fail)
RED: board diff (1 fail)
RED: evidence guard (2 fail)
RED: reason vocabulary guard (1 fail)
RED: speech skip (1 fail)
RED: flash cap (1 fail)
GREEN: restored sources; 15 pass

```

The oversized previous list uses 26 distinct known ids, and the bad reason uses an otherwise selected id, so unrelated validation cannot mask those regressions. Tests also cover exact selection/diff membership, rank retention, code vocabulary, long-id facts budgeting, cached response compatibility, reel timing, combo reset/cap, particle count/lifetime, calm gating, speech suppression, and a rolling flash envelope cap. One visual luminance envelope per second is stricter than the requested maximum of three; individual reels use movement, not flashing.

## Checks

- Dashboard: `bunx tsc --noEmit` passed.
- Backend: `bunx tsc --noEmit` passed; full `bun test`: 735 passed, 17 database tests skipped without TEST_DATABASE_URL, zero failed.
- `parrot-no-authority.test.ts` included and green.
- `bun run build` hit the existing Turbopack filesystem-root/symlink restriction. `bun run build --webpack` passed, including static `/parrot` generation.
- No new dependencies; no edits to Score, `packages/shared/strategy-intent.ts`, Live persona/config/allowed-events, limits or migrations.
- Existing expectations changed only for the new `evidence` response key and evidence in the live guard test fixture; the generated-fixture test now asserts 40 sample rows and four exclusion controls. No prior wallet-address assertions were relaxed.
- Git add/commit could not create the worktree index lock: `Operation not permitted` in the repository's external `.git/worktrees/parrot-board` directory. Changes remain uncommitted.

## Unverified without a screen or speakers

- Actual 375 px and desktop layout, absence of horizontal scrolling, both themes, contrast and text clipping.
- Card movement/FLIP, reel lock timing, ghost collapse/reentry, counter motion, portrait/blink/bob, clamp motion, feather/ray/shimmer layering and visual taste.
- Pointer/touch tilt and reason tooltips, visible keyboard focus, screen-reader announcements, and unobscured/clickable conclusions and lock controls during effects.
- Browser persistence and OS reduced-motion/Calm transitions, actual animation cancellation on navigation/visibility loss, and real laptop 60 fps/low-power behavior.
- Live remote audio reactivity, autoplay fallback, synthesized sound quality/volume/pitch, visitor-speech suppression under real microphone latency, and speaker feedback.
- Actual rendered photosensitivity compliance: the schedule cap is tested as data; no visual luminance measurements were performed.
- Real microphone/provider E2E, database persistence or deployed behavior.

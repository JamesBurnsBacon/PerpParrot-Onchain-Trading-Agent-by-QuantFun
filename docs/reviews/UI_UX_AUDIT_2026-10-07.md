# PerpParrot: deeper UI/UX audit

Report only. No application code, configuration, dependencies or trading behavior changed.

Reviewed 7 October 2026 against source revision `f97271aea46641127dc2d8eb7468cc8cb9bbb161` and the deployed app at https://perpparrot.vercel.app. Deployment/source parity was not independently established. Findings distinguish browser observations from source-derived risks.

## Executive recommendation

Make the first visit explain the product, make data provenance explicit, and make details usable without hovering. Preserve the existing visual identity. Address data-state clarity before adding more motion or decoration.

The clearest small changes are an immediate dashboard action, honest loading/error states, live/paper labels and visible target values. The voice page also needs a narrow-screen layout correction and readable recovery messages.

## Scope and method

- Live inspection: landing scroll sequence, dashboard, performance Chart/Table toggle, contributor what-if and `/parrot` voice entry. The first-pass what-if was restored; the deeper pass activated no trading or microphone controls.
- Deeper live inspection: cold reload and recovery to populated data, heartbeat interaction, 1280×800 dashboard and 320×740 dashboard/voice entry. Previous pass also inspected 375×812. Viewport overrides were reset.
- Read-only source inspection: data loading and formatting, performance origins, target chart, contributor flow, run log, header, hero, voice controls, confirmation presentation and modal implementation.
- Guidance applied: installed Don't Make Me Think usability lenses, composition critique, and cached skills.sh [information-density critique](https://skills.sh/owl-listener/designer-skills/critique-information-density). This is expert review, not a human usability study or formal accessibility certification.
- No induced network outage, permissions prompt, voice session, wallet connection, strategy save or funded order. Runtime failure behavior below is explicitly untested where identified from code.

## Findings and proposed acceptance criteria

Priority: P1 = address before presenting to unfamiliar customers; P2 = next usability pass; P3 = polish. These are product priorities, not claims of security severity. Acceptance criteria are proposed checks, not tests already passed.

### 01 · P1 · The first frame does not explain the product or offer an immediate action

- Evidence: **Live + source.** First frame shows “SO MANY TRADERS!”; subsequent scroll states show metaphorical headlines. `Hero.tsx:73–81` reveals the CTA only in the final progress segment; `lp.css:97` allocates 300svh to the moving journey.
- Impact: visitors must explore an animation before learning what they gain or reaching the useful view.
- Proposal: retain the artwork and scroll story, but keep “Understand several traders as one portfolio plan” and “See the portfolio” available from the first frame.
- Acceptance: fresh visit exposes the benefit and a keyboard-reachable dashboard link before any scrolling, including reduced-motion mode.

### 02 · P1 · Loading is presented as an empty product

- Evidence: **Live + source.** Immediately after reload, the page showed “No runs yet,” “Pipeline not running yet” and “Roster not running yet”; the next observation contained populated data. `page.tsx:64`, `:94`, `:100` and `:109` reuse these states before initial loading completes.
- Impact: a customer can interpret a normal fetch as a broken or inactive system.
- Proposal: distinguish initial loading, successfully loaded empty data and unavailable data. Show quiet skeletons or “Loading portfolio…” during the first request.
- Acceptance: a slow first request never claims no runs exist; a successful empty response still produces an explicit empty state.

### 03 · P1 · Failure and freshness are not represented separately

- Evidence: **Source-derived; outage not induced.** `lib/data.ts:157–176` converts HTTP failures, parsing/network exceptions into `null`; `useDashboard` replaces state every minute. `loadedAt` is assigned after the batch whether requests succeed or fail. `page.tsx:38` maps missing status to “Executor offline.”
- Impact: a failed read can erase a useful last-known view, and inability to contact one endpoint can be mistaken for proof that the executor is offline.
- Proposal: keep per-resource loading/error state, retain last successful data with an explicit stale label, and track last successful refresh separately from request completion. Distinguish “Status unavailable” from a verified offline condition.
- Acceptance: simulate one failed resource and a total outage in a non-production test; unaffected panels remain usable, stale values are labeled, and recovery removes the warning without reloading.

### 04 · P1 · Live and modeled returns lack equally explicit provenance

- Evidence: **Live + source.** Aggressive says “13 runs executed”; other cards say “modeled.” `page.tsx:40–53` intentionally omits the live origin label. `lib/data.ts:228` chooses a live curve based on a non-dry executed run plus equity points.
- Impact: visitors must infer whether each number is actual account behavior or simulation. A completed run is also not synonymous with a filled order.
- Proposal: display “Live account,” “Paper model” or “Benchmark” consistently on cards, chart legends and tables, using verified data. Keep run status separate from order/fill status.
- Acceptance: switching the Aggressive source between paper and live changes all relevant labels consistently. A zero-order completed run is not described as a filled trade.
- Boundary: this audit did not independently verify funded fills and does not recommend relabeling the observed live account as paper.

### 05 · P1 · Return comparisons can use different starting times without saying so

- Evidence: **Live + source.** The table contained absent Aggressive values at earlier timestamps while other series already had values. `performanceSeries` in `lib/data.ts:231–249` bases live returns on the live equity series and paper returns on each book's starting capital.
- Impact: side-by-side latest percentages invite a same-period comparison even when the periods differ.
- Proposal: show each series' start date/time and calculation basis. Offer a clearly labeled common-period comparison only if supported by the source data; retain original since-start figures separately.
- Acceptance: different series start times are apparent before interpreting the headline values. No normalization changes are silently applied.

### 06 · P1 · Target magnitude is hidden behind pointer interaction

- Evidence: **Live + source.** The target graphic shows assets and reasons such as “within drift,” but precise percent-of-equity values appear in its footer only on hover. `Charts.tsx:223–245` attaches pointer events to non-focusable SVG groups.
- Impact: a keyboard or phone reader has difficulty answering the primary question: what direction and size is this position?
- Proposal: render visible “Long/Short · x% of equity” text per row and a semantic value table. Keep the no-trade reason secondary.
- Acceptance: every visible target's asset, direction and magnitude can be read without hovering, including keyboard-only and 320px layouts.

### 07 · P2 · “+1 more” acknowledges a hidden asset without a way to inspect it

- Evidence: **Live + source.** Target portfolio displayed “+1 more.” `Charts.tsx:200` limits rows to 14; `:247` renders the remainder count as text.
- Impact: users cannot inspect the full plan from this panel despite being told another target exists.
- Proposal: add “Show all targets” or link to an accessible full list, preserving the compact default.
- Acceptance: all plan assets are reachable through a labeled control; hidden count matches the expanded list.

### 08 · P1 · Narrow layouts hide useful table columns and part of the voice action

- Evidence: **Live.** At 375px the performance summary's Positions column was clipped. At 320px the roster's Tenure column was partly offscreen, and `/parrot` visibly cut the “Talk live” label at the right edge.
- Locations: `Charts.tsx` PaperTable, `Roster.tsx`, `app/parrot/parrot-show.css` voice layout overrides and `LiveTalk.tsx` label placement.
- Impact: tables rely on undisclosed horizontal exploration; the main voice action loses its text label.
- Proposal: use compact stacked summaries or an obvious scroll affordance for tables. Let the voice button and label wrap or stack within the available width.
- Acceptance: 320px and 375px views expose the complete voice action; all table columns are discoverable without page-level horizontal overflow. Test landscape and larger text separately.

### 09 · P2 · Navigation disappears on narrow screens rather than changing form

- Evidence: **Live + source.** At 1280px, Performance/Pipeline/Roster anchors are present; `lp.css:398` hides navigation below 900px. The earlier review's claim that section navigation was absent everywhere is therefore superseded.
- Impact: a long phone dashboard requires repeated scrolling to move between sections.
- Proposal: preserve the wide navigation; provide a compact section menu on phones including Portfolio, Contributors and Activity as well as existing sections.
- Acceptance: section navigation remains reachable at 320px; anchor destinations are not obscured by the sticky header.

### 10 · P2 · Pro suggests a paid upgrade but lands directly in a voice experience

- Evidence: **Live + source.** The crown/“Pro” link opens `/parrot`; the destination initially says “YOUR FLOCK” and “Say something.” `DashHeader.tsx` describes the crown as a paid-tier badge, but no upgrade explanation was visible in the inspected entry state.
- Impact: destination expectations and the useful task do not match the label.
- Proposal: either call the destination “Ask PerpParrot,” or explain what Pro provides before presenting the microphone. Add example questions and clearly state the voice experience's capabilities and limits.
- Acceptance: a first-time visitor can explain what clicking the link will do, and can see an example useful question before microphone permission is requested.

### 11 · P2 · Voice and strategy error explanations are hidden from sighted users

- Evidence: **Source-derived; failure state not induced.** `LiveTalk.tsx` displays compact “Try again”/“Allow mic” status while putting `view.status` in `sr-only`. `ExecutePanel.tsx:23` likewise hides `describeError(...)` and visibly shows only “Try again.”
- Impact: a person can repeatedly retry without knowing whether to allow a microphone, wait for a rate limit or address another condition.
- Proposal: expose a short human-readable reason and actionable recovery text visually, while retaining the existing accessible announcements. Show retry timing when applicable.
- Acceptance: microphone denied, disconnected, service unavailable and rate-limited states each display the appropriate next step in a fixture or non-production test.

### 12 · P2 · Contributor exploration is visually dense and needs a more precise what-if explanation

- Evidence: **Live + source.** Many wallet-to-asset lines cross. The what-if statement is below the full graphic. `ExposureFlow.tsx` makes the diagram taller as asset count grows. `lib/exposure-flow.ts:38–40` subtracts selected recorded contributions from returned targets; it is not a fresh complete portfolio-policy execution.
- Impact: users can mistake the local attribution exercise for re-running selection, caps and executor rules.
- Proposal: place “What-if view only” by the controls, offer a single-asset view, show a reset action and explain the specific subtraction method. Keep the full map available for exploration.
- Acceptance: muting changes only the view, shows which recorded contribution was excluded, and never implies a strategy was saved or a new funded target authorized.

### 13 · P2 · The target chart lacks an equivalent accessible numeric representation

- Evidence: **Source-derived.** `TargetPortfolio` wraps SVG in a generic image label; exact magnitudes are not represented by a parallel numeric table. The contributor flow already has semantic tables and can serve as a reference pattern.
- Impact: screen-reader users may hear asset names and action reasons without enough data to understand target sizing.
- Proposal: add a concise accessible table of asset, target direction, percent of equity and action reason; do not rely on SVG geometry alone.
- Acceptance: manually inspect with a screen reader and keyboard; all shown targets can be read in order. This is a proposed test, not a WCAG compliance claim.

### 14 · P2 · Run evidence controls provide weak failure feedback

- Evidence: **Source-derived; clipboard denial not induced.** `RunLog.tsx` handles rejected `writeText` with an empty callback. Success changes the icon/title, but there is no equivalent visible failure message.
- Impact: a browser permission or clipboard limitation can leave the user unsure whether the requested copy happened.
- Proposal: show “Hash copied” or “Couldn't copy—select this hash” with a polite status announcement and a selectable fallback.
- Acceptance: fulfilled and rejected clipboard calls both produce understandable feedback; repeated success messages remain announced without stealing focus.

### 15 · P2 · Operational jargon and unlabeled input percentages need context

- Evidence: **Live + source.** Pipeline and roster show abbreviated wallets, ceilings, fit/copyable scores, “7 of 5–15,” and “Implied copy turnover.”
- Impact: customers may confuse input weight with cash allocation or treat internal scores as independently measured product guarantees.
- Proposal: label input shares explicitly; define the selected-trader range and turnover units. Put scale/meaning beside scores and retain detailed policy explanations under disclosure.
- Acceptance: a new reader can distinguish source weight, target exposure and account equity without reading source code.

### 16 · P3 · Rounded zero and local-only timestamps lose useful context

- Evidence: **Live + source.** “-0.00%” appeared in the table; `pct` at `lib/data.ts:252` formats the raw sign. `time` at `:255` uses browser-local time with no timezone shown.
- Impact: tiny values appear negative after rounding; screenshots shared across locations or days are ambiguous.
- Proposal: normalize displayed rounded zero to neutral “0.00%.” Show date/timezone in panel metadata or a clear page-level time convention.
- Acceptance: small positive/negative values that round to zero look neutral; shared captures identify their timezone and date.

## What to preserve

- The consistent green/cream visual system and recognizable mascot.
- The working Chart/Table toggle and responsive two-column return cards.
- Contributor controls with pressed state and an accessible numeric table.
- Native details disclosure for secondary costs and pipeline information.
- Existing reduced-motion handling; verify its behavior rather than replacing it blindly.
- Confirmation guardrails, dry-run statements and voice controls that cannot themselves authorize trades.
- Demo modal's native dialog, close label, focus restoration and escape-compatible lifecycle. No broken-modal claim is made; the Demo button was not visible in the inspected deployment, and configuration intentionally hides it when no valid video exists.

## Proposed verification matrix for a later implementation

| Scenario | What to verify | Current audit evidence |
|---|---|---|
| Fresh visit | Benefit and dashboard action available immediately | Landing scroll sequence inspected |
| Slow request | Loading remains loading until data resolves | Empty-state flash observed on reload |
| Partial HTTP failure | Correct panel warning, last known data retained and labeled | Source risk only |
| Total outage and recovery | No false empty-system claim; recovery works | Source risk only |
| Live/paper and different start times | Provenance and periods explicit | Source logic and live table inspected |
| 320/375/1280px | Complete labels, readable target values and discoverable tables | Representative live screenshots inspected |
| Keyboard/screen reader | Target values, anchors, toggles and failure feedback usable | DOM/source inspection; full assistive-technology task not run |
| Voice denied/rate-limited/disconnected | Visible reason, next action and mic-off state | Source only; no mic activation |
| Zero targets / >14 targets | Real empty state and full-list access | Hidden target count observed; boundary fixtures not run |
| Reduced motion / large text | Product meaning and actions remain available | Source only; runtime variants not run |

## Review limits

- No application modifications, build, deploy, strategy save, trade, account connection or voice session.
- Application tests were not run: this PR adds an audit document only. Proposed tests above are not completed checks.
- No fabricated user quotes, conversion estimates, measured time savings or numeric accessibility certification.
- Source line references apply to the pinned revision and may move. Product data is dynamic; observed labels and states are evidence of the reviewed session rather than a permanent data snapshot.
- This report supersedes overbroad statements from the first pass: desktop section navigation exists, and mobile tables have overflow containers even though the scroll affordance is weak. Do not remove working behavior to satisfy the earlier wording.

## Suggested order

1. Honest loading/failure states and live/paper/period labels.
2. Immediate first-frame benefit/action and mobile voice layout.
3. Visible target values/full-list access and accessible numeric representation.
4. Mobile navigation, contributor exploration, recovery feedback and terminology.
5. Formatting polish and a five-question test with actual unfamiliar readers.

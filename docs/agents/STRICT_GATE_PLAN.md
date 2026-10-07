# Strict AI gate: plan (owner decisions, 2026-10-07)

**For:** Bradley and his coding agent. **Builds on:** PR #50 (measured evidence). **Status:**
decided by the owner; to be built. Read `AGENTS.md` first. The executor stays in dry run.

## Why

Every 10 minutes the pipeline picks 25 finalists from the qualified list (Score). When the 25
change, three models review them: Role, Risk, then Red-Team on a draft portfolio. The review
core (`packages/backend/review/workflow.ts`) then decides deterministically which sources make a
configuration, which needs **5 to 25 sources**. It has never passed 5. Production uses the
**basic gate** fallback (`REVIEW_GATE`, `src/pipeline/index.ts` `basicSources`). We want the AI
review to be the real decision-maker.

PR #50 gave the models the measured evidence they asked for:
- hold time, leverage and time in market;
- trailing out-of-sample windows;
- execution fit and pair exposure overlap.

Live run, 220 accounts, 25 finalists, real model calls:

| | Evidence risk (model) | Pass every per-candidate check |
|---|---|---|
| Before #50 | 80 for all 25 | 0 |
| With #50 | 30–80 | 1 |

What blocks candidates now is **policy**, not missing data.

## How the gate works today

The review core keeps a candidate only if **all** of these hold (`compile`):
1. History ≥ `minHistoryDays`, out-of-sample windows present, median hold ≥ 60 min, and
   execution fit ≥ `minExecutionFit` (50).
2. **Confidence:** Role confidence and Risk confidence are each ≥ `minConfidence` (**60**).
   Prompt definition: "Confidence measures evidence adequacy, not expected profit. Missing
   evidence must lower confidence." The scale is 0 unsupported, 50 mixed, 100 strong. The 60
   was hand-set in the policy fixture, never calibrated.
3. Role `reject` < 80.
4. **Risk decision** (`riskDecision`): take the **highest** of six Risk scores (drawdown,
   leverage, concentration, path, execution, **evidence**):
   - ≥ 80 → REJECT;
   - 60–79 → WATCHLIST;
   - otherwise CAP.

   The source's weight ceiling is `maxSourceWeight × (1 − highest/100)`.

Survivors are weighted by Aggressive fit (discounted for holds under 6 h) and must be pairwise
compatible (correlation ≤ 0.8, exposure overlap ≤ 0.5). That forms a draft.

**Red-Team rebuild rule:** the Red-Team scores the draft (`rebuildScore`, `portfolioRisk`) and
may penalise sources (`multiplier` 0.5–1, `excludeScore`).
- If either score is ≥ 70, or any multiplier is < 1, the core rebuilds **once** with those
  penalties. It never adds sources or redistributes weight.
- A score ≥ 70 **with no source penalised** rejects the whole review (`POLICY_VIOLATION`).

In the live run the draft held one source; the Red-Team scored it 75 and named nothing to cut.

## Decisions

1. **Evidence risk informs confidence only.** Score already pre-filters to high performers, so
   evidence risk is double-counted: it lowers confidence *and* decides REJECT/WATCHLIST/ceiling.
   It should leave the risk decision.
2. **Confidence scales weight instead of cutting at 60.** A candidate's score is multiplied by
   its confidence. A low safety floor (40) still drops candidates the models can't assess.
3. **Keep the 5-source minimum.** Not up for change.
4. **Basic gate stays the fallback** until strict reliably produces ≥ 5 sources. Removing it is
   the owner's call, later.
5. **Target: at least 12 of the 25 finalists pass** the per-candidate checks. Today's rules are
   too strict; Score has already done the performance filtering.

Measured on the live run's actual model outputs, decisions 1 and 2 take passing candidates from
**1 to 4**: far from 12, so the evidence work below is needed, and likely more. Remaining blockers among the
25:
- 14 have another risk (drawdown, leverage or path) ≥ 80;
- 14 have min(Role, Risk) confidence < 40 (ten are at 30);
- 9 have execution fit < 50;
- 5 have a Role reject ≥ 80.

These are one run's numbers; model outputs vary between runs.

## Work (Bradley, in this order)

### PR 1: gate changes (`packages/backend/review/workflow.ts`)
- `riskDecision`: status and ceiling use the highest of drawdown, leverage, concentration, path
  and execution. `evidenceRisk` stays in the Risk output, the audit and the dashboard, but stops
  deciding.
- `compile`: replace the two `confidence < minConfidence` cuts with:
  - a floor: drop a candidate if `min(roleConfidence, riskConfidence) < minConfidence`;
  - a scale: `score = fit × latency × min(roleConfidence, riskConfidence) / 100`.
- Set `minConfidence` to **40** in the policy the pipeline reviews under. **Gotcha:** today
  `reviewPolicy()` reads `fixtures/frozen-configuration.json`. Changing that file changes the
  fixture's `configurationHash`, which production pins in `FROZEN_CONFIGURATION_HASH` as the
  fallback configuration, so the backend would refuse it. Give the pipeline its own policy file
  (e.g. `packages/backend/fixtures/review-policy.json`) and leave the fixture alone.
- Update `tests/review.test.ts` and `tests/support/review-fixture.ts`, plus any doc that states
  the old rule (`docs/agents/*`, README §4.6). The system prompts don't change.

### PR 2: the evidence the prompts still ask for (`src/pipeline/evidence.ts`, `review/input.ts`)
- **Trade-path patterns** from the fills `evidence.ts` already reads: `patterns.observedFills`,
  `increasesAfterLoss` (adds to a losing position) and `repeatedRoundTrips`. Today all are null,
  and the Risk prompt says to raise evidence risk "when trade-path data is absent". This is the
  most direct lever on both confidence and path risk.
- **`btcBeta`** from the month returns against BTC's.
- **`survivorshipQuality`**: honestly `CURRENT_SNAPSHOT` today (hard-coded `UNKNOWN`).
  Point-in-time can come later from the stored 12-hour scans.

**Coordinate with #45** (advisory strategy notes). It already reads the 25's positions and
classifies exposure (crypto, gold, oil, unclassified) for a separate model call that doesn't
affect selection. Data that helps a model judge a source belongs in the committee's evidence (the
frame and `review/input.ts`), where it moves confidence and risk, rather than in a parallel
advisory path. Both #45 and #50 edit `src/pipeline/index.ts`, so rebase one on the other.

### Then measure, and propose
- Run `packages/backend/scripts/strict-gate-check.ts` (in #50) on live data with
  `--gate strict`, several times. Report per run how many of the 25 pass and the blocker counts,
  in the format of the table above.
- **Done when:** at least **12 of 25** pass the per-candidate checks in most runs, and the
  review produces a VALID manifest (≥ 5 sources).
- If evidence alone doesn't get there, **propose rather than apply** further policy changes, each
  with its measured effect on the same runs. Candidates, all owner's calls:
  - the 80 reject bar for drawdown, leverage and path risk (14 of 25 blocked in the live run);
  - the 40 confidence floor;
  - `minExecutionFit` 50;
  - reviewing more than 25 finalists (possible since #39 removed the CRE-era 105 KB limit).

## Ground rules for the agent
- Other Claude sessions share the main checkout: work in your own git worktree, open PRs against
  `main`, never clean `work/`.
- Don't change thresholds other than those above. Don't commit generated evidence. No CI
  workflow that spends secrets.
- Keep PRs small: under ~1,500 changed lines excluding tests.
- Never print secrets. The owner runs any migrations in Supabase by hand.
- Checks:
  - `bun test` and `bunx tsc --noEmit` in `packages/backend` and `packages/executor`;
  - root `node --test tests/*.test.ts` on Node 24, where frame contracts are byte-synced with
    `docs/agents/SYSTEM_PROMPTS.md`.

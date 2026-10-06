# Team alignment — 7 October 2026, UTC+8

Latest manual code/comment check: **04:18 +08**. No teammate commit newer than the
integration baseline was found. CI and Vercel bot updates are not teammate code changes.

| Contribution | Current reference | This branch uses / supplies |
|---|---|---|
| James: ordinary backend/executor services, CRE removal | [PR #32](https://github.com/JamesBurnsBacon/PerpParrot-Onchain-Trading-Agent-by-QuantFun/pull/32), `af7e857` | PR #33 remains based on this open branch. Same frozen configuration, snapshots, targets and executor interfaces. |
| Masa: Score and maker-share ranking | Current checked-in Score on the above baseline | Strict eligibility and ranking reused; no replacement ranking formula or relaxed filters. |
| Masa: Talk to the Parrot | [PR #30](https://github.com/JamesBurnsBacon/PerpParrot-Onchain-Trading-Agent-by-QuantFun/pull/30), `5a4f0fd` | Its stated data gap is a real `funnel` artifact. The measured adapter exports this exact shared dashboard contract. `picked=false` until a real review is valid and frozen. |
| Bradley: recurring Top 100 | [PR #31](https://github.com/JamesBurnsBacon/PerpParrot-Onchain-Trading-Agent-by-QuantFun/pull/31), `afc8358` | Existing worker remains on that version. New recovery, replacement and rotation behavior is in PR #33, with separate evidence. |

The Parrot UI is an advisory/simulation interface. Its voice or chat output does not
become execution authority. A valid reviewed and frozen configuration remains the
handoff to the mirror.

For tomorrow: review [MEASURED_PIPELINE.md](MEASURED_PIPELINE.md), use the published
`funnel.json` with `scripts/publish-artifact.ts` (validation first), and read the
measured decision diagnostics before changing algorithms. The rehearsal's fixed
historical holdouts and short leverage observation are explicitly labelled; they
do not establish a prospective model winner.

Preview builds pass, but unauthenticated health requests redirect to Vercel login.
Hosted backend/executor health and the intended Supabase deployment remain unverified.

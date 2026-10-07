# Prompt calibration candidate (research, not a live approval)

This branch proposes version 1.2.0 of the Role, Risk and Red-Team system prompts.
The change separates absent evidence from observed unsafe behavior. It does **not**
change the deterministic risk threshold, confidence floor, source limits, sizing,
execution code or frozen configuration. A model output still has no authority to
place an order.

The local experiment reused one saved cohort: 140 accounts, 20 excluded by the
no-HFT screen, 120 scored and 40 finalists (30 vaults, 10 traders). Score/fill
reference time was 2026-10-07 05:51:45 UTC. Some position reads were saved later,
so this is a mixed-time integration rehearsal, not a synchronized backtest.
All calls used GPT-6 Sol, the same anonymous evidence, schemas and local strict
policy. Request hashes matched for evidence and policy; prompt hashes changed.
Each row below completed Role, Risk and Red-Team with HTTP 200 and valid output.

| Prompt version tested | Candidate checks | Paper sources after Red-Team | Five-source minimum | Interpretation |
| --- | ---: | ---: | --- | --- |
| Existing v1.1.0 | 5/40 | 3 | No | Baseline; validated replay of real provider output |
| Uncertainty calibration alone | 14/40 | 9 | Yes | Rejected: two strongly observed adverse-add paths fell below the risk veto |
| Add explicit adverse-add guard | 11/40 | 3 | No | Path scores recovered; Red-Team excluded seven of ten draft sources |
| Proposed v1.2.0, observation 1 | 10/40 | 6 | Yes | Full three-stage live API rehearsal, paper only |
| Proposed v1.2.0, observation 2 | 9/40 | 5 | Yes | Exact-prompt repeat on the same saved cohort, paper only |

The rejected first variant rated candidate 5's and 16's path risk at 79 and 76,
despite observed adverse-price adds in approximately 98% of 727 and 111
reconstructed cost-basis adds, respectively. The proposed prompt explicitly
keeps such well-sampled behavior high risk: those candidates scored 100/96 in
observation 1 and 98/94 in observation 2, and neither entered the paper roster.
Missing path measurements still lower evidence confidence without inventing
severe *observed* path behavior.

The final Red-Team guidance asks for an additional supported portfolio-level
reason before severe exclusion. It can still exclude linked sources, correlated
or same-side exposure, leverage stacking and uncopyable turnover. Candidate 32
entered both paper rosters despite only 13 observed fills and no reconstructed
cost-basis adds. That sparse path evidence needs direct inspection before any
live admission; the five-source count does not resolve it.

These observations are on one selected historical cohort. They do not establish
profitability, safety, generalization or a stable pass rate. The two repeats
differed by one candidate and one paper source. Before promoting this prompt,
rerun on a later untouched cohort, inspect newly admitted candidates and the
copy-target replay, and compare outcomes with the original prompt under the same
point-in-time inputs. Do not tune thresholds or prompt wording to hit a target
count. Private snapshots and raw provider responses remain in ignored local
`work/`, not in GitHub.

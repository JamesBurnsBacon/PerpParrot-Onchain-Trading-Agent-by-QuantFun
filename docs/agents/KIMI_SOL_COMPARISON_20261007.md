# Kimi K3 / GPT-6 Sol: isolated Top35 committee experiment

This research work is based on PR #58 at `6af40e8`, after its rebase through main's #73–#75 (`2a56d9f`). It does not select a new production provider, change the live roster, or submit orders. Results and raw evidence remain in the ignored `work/kimi-sol-top35-20261007/` directory.

## What Top35 means here

The existing research cohort has 35 candidates. Production `PICKS` and the version 1.1.0 review schemas still allow 25. Simply changing a script's candidate count cannot create a valid production review of 35.

`prepare-top35-comparison.py` makes a separate runtime under `work/`. Its checked, recorded changes are limited to candidate IDs 0–34, 35 rating rows, the complete 595-pair matrix, the distinct `research-35-v1` contract, `SIMULATION` mode, and a maximum 300-second research deadline. The production schemas and deadline are unchanged. Production validation rejects this research frame and manifest, even if the research result says `VALID`.

The shared gate, risk dimensions, weights, pair checks, Red-Team rebuild/exclusion, portfolio assessment and five-source freeze minimum are unchanged in the copy. This experiment uses the checked-in `review-policy.json` thresholds for both models. It does **not** apply the other conversation's exploratory V2 risk-budget policy or treat its provisional candidates as provider approvals. The review fixture's gross-leverage cap is 3; James's live executor cap and #74 counted-gross calculation are a different boundary. The pipeline review's `assess` closure is not an executor order-plan validation.

## Fixed experiment

- Inputs: 140 saved accounts; exclude 20 high-frequency accounts; Score ranks the remaining 120 and selects the same 35 used by the earlier Top35 rehearsal.
- Score/fill reference time: 2026-10-07 05:51:45 UTC. The previously recorded Top35 position reads span 07:21:59.759–07:22:03.882 UTC. Missing public fill reads were completed once with the historical end time, then the cache was frozen. This mixed-time evidence is suitable for a controlled model comparison, **not** a synchronized backtest or return estimate.
- Models: official `kimi-k3` and `gpt-6-sol`, each `reasoning_effort: high`, `max_completion_tokens: 32768`, strict structured output. Sampling parameters are omitted. Equal effort labels do not establish equal internal compute.
- Both receive byte-identical Role/Risk user messages, prompts and output schemas. Hashes are recorded and checked. Red-Team sees the same evidence and rules but each model's own compiled draft, which may differ.
- Each model supplies one observation per specialist stage (quorum 1). Role, Risk and Red-Team are specialist prompts, not three independent providers voting.
- Public account identities are stripped from model evidence; draft sources also exclude addresses. Keys are used only in official provider authentication headers. Reports exported for review contain candidate IDs, not wallet addresses or account holdings.
- Offline cache misses stop inference. Results are written only to a local PGlite database. No production database connection, roster activation or trading is involved.

## Reproduction

Install the repository's existing root/backend dependencies first. Keep account keys in a Git-ignored environment file; do not paste them into commands or reports.

```sh
python3 scripts/prepare-top35-comparison.py work/my-comparison/runtime
bun --env-file=/path/to/private-provider.env run \
  work/my-comparison/runtime/packages/backend/scripts/strict-gate-check.ts \
  --provider kimi --model kimi-k3 --finalists 35 --offline \
  --inputs /path/to/frozen-inputs.json --reads /path/to/frozen-reads.json \
  --as-of 2026-10-07T05:51:45Z --local-dir work/my-comparison/kimi-db \
  --serial --stage-spacing-ms 65000 --timeout-ms 300000 \
  --output work/my-comparison/kimi.json
```

Run the same command with `--provider openai --model gpt-6-sol`, its environment file and a separate local database/output. `--prepare-only` captures requests without contacting a model. This cannot be counted as a paid inference run.

If a stage completed before a later timeout, `--replay-run previous.json` can reuse only its validated observation, bound to the same evidence, model, prompt and (for Red-Team) draft. The bridge revalidates it, and the report identifies reused stages and the prior file's commitment. Such a resumed comparison measures scores and individual request latency; it is not proof that a continuous production run met its deadline.

```sh
python3 scripts/summarize-committee-comparison.py \
  work/my-comparison/kimi.json work/my-comparison/openai.json \
  work/my-comparison/comparison.json
```

The summarizer refuses mismatched conditions, Top25 inputs labelled as Top35, or prepare-only results. A failed/incomplete model has `candidatePass: null`, never a misleading zero. Candidate admission, core manifest status and five-source freeze eligibility are separate fields. A higher pass count alone does not measure accuracy or profitability; multiple dates and independent evidence are still needed.

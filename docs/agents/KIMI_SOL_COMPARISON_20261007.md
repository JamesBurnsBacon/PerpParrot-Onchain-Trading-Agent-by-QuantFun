# Kimi K3 / GPT-6 Sol: isolated Top40 committee experiment

This research work aligns with PR #58 and main through #78 (`7c05d74`). Native Top40 support is being integrated separately in PR #58; the research runtime records its exact source commit and file hashes. It does not select a new production provider, change the live roster, or submit orders. Results and raw evidence remain in the ignored `work/kimi-sol-top40-20261007/` directory.

## What Top40 means here

Top40 is the candidate pool sent to the committee. It does not increase the 15-source allocation cap or lower the five-source freeze minimum. The earlier Top35 experiment is historical and is not a current Top40 result.

`prepare-committee-comparison.py` makes a separate runtime under `work/`. Its checked, recorded changes are limited to candidate IDs 0–39, 40 rating rows, the complete 780-pair matrix, the distinct `research-40-v1` contract, `SIMULATION` mode, and a maximum 900-second research deadline. The generator only edits the isolated runtime, never production source or its 60-second deadline. Role and Risk share one stage deadline; Red-Team receives a new deadline. Calls are serialized with a 65-second gap to respect provider limits. Production validation rejects this research frame and manifest, even if the research result says `VALID`.

The shared gate, risk dimensions, weights, pair checks, Red-Team rebuild/exclusion, portfolio assessment and five-source freeze minimum are unchanged in the copy. This experiment uses the checked-in `review-policy.json` thresholds for both models. It does **not** apply the other conversation's exploratory V2 risk-budget policy or treat its provisional candidates as provider approvals. The review fixture's gross-leverage cap is 3; James's live executor cap and #74 counted-gross calculation are a different boundary. The pipeline review's `assess` closure is not an executor order-plan validation.

## Fixed experiment

- Inputs: 140 saved accounts; exclude 20 high-frequency accounts; Score ranks the remaining 120 and selects 40: 30 Hypercore vaults and 10 traders. Both providers use this same ordering and frozen cache.
- Score/fill reference time: 2026-10-07 05:51:45 UTC. All 40 candidates' core/xyz positions were refreshed at 09:09:40.350–09:10:00.033 UTC (80 reads); five missing public fill reads were completed with the historical end time, then the cache was frozen. This mixed-time evidence is suitable for a controlled model comparison, **not** a synchronized backtest or return estimate.
- Models: official `kimi-k3` and `gpt-6-sol`, each `reasoning_effort: high`, `max_completion_tokens: 32768`, strict structured output. Sampling parameters are omitted. Equal effort labels do not establish equal internal compute.
- Both receive byte-identical Role/Risk user messages, prompts and output schemas. Hashes are recorded and checked. Red-Team sees the same evidence and rules but each model's own compiled draft, which may differ.
- Each model supplies one observation per specialist stage (quorum 1). Role, Risk and Red-Team are specialist prompts, not three independent providers voting.
- Public account identities are stripped from model evidence; draft sources also exclude addresses. Keys are used only in official provider authentication headers. Reports exported for review contain candidate IDs, not wallet addresses or account holdings.
- Offline cache misses stop inference. Results are written only to a local PGlite database. No production database connection, roster activation or trading is involved.

## Reproduction

Install the repository's existing root/backend dependencies first. Keep account keys in a Git-ignored environment file; do not paste them into commands or reports.

```sh
python3 scripts/prepare-committee-comparison.py work/my-comparison/runtime
bun --env-file=/path/to/private-provider.env run \
  work/my-comparison/runtime/packages/backend/scripts/strict-gate-check.ts \
  --provider kimi --model kimi-k3 --finalists 40 --offline \
  --inputs /path/to/frozen-inputs.json --reads /path/to/frozen-reads.json \
  --as-of 2026-10-07T05:51:45Z --local-dir work/my-comparison/kimi-db \
  --serial --stage-spacing-ms 65000 --timeout-ms 900000 \
  --output work/my-comparison/kimi.json
```

Run the same command with `--provider openai --model gpt-6-sol`, its environment file and a separate local database/output. `--prepare-only` captures requests without contacting a model. This cannot be counted as a paid inference run.

If a stage completed before a later timeout, `--replay-run previous.json` can reuse only its validated observation, bound to the same evidence, model, prompt and (for Red-Team) draft. The bridge revalidates it, and the report identifies reused stages and the prior file's commitment. Such a resumed comparison measures scores and individual request latency; it is not proof that a continuous production run met its deadline.

```sh
python3 scripts/summarize-committee-comparison.py \
  work/my-comparison/kimi.json work/my-comparison/openai.json \
  work/my-comparison/comparison.json
```

The summarizer refuses mismatched conditions, an inconsistent candidate-count/contract label, or prepare-only results. A failed/incomplete model has `candidatePass: null`, never a misleading zero. Candidate admission, core manifest status and five-source freeze eligibility are separate fields. A higher pass count alone does not measure accuracy or profitability; multiple dates and independent evidence are still needed.

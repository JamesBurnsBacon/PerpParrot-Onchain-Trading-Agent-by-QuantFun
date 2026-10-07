# Top 40 committee comparison: GPT-6 Sol and Kimi K3

The production pipeline now picks **40 finalists** every 10 minutes; its review may approve **at most 15** sources. The source cap, five-source minimum, risk policy, weights and execution rules are unchanged. OpenAI remains the production provider. Kimi is only an isolated research comparison, with no authority to change the roster or place orders.

The comparison uses one frozen local cohort: 140 saved accounts, 20 excluded for high order frequency, 120 scored, then 40 finalists. Its Score/fill reference time is 2026-10-07 05:51:45 UTC. Some position reads were fetched later while completing the 40-person cache. This mixed-time evidence tests the review integration and model sensitivity; it is **not** a synchronized backtest or a return estimate. Raw account evidence, provider responses and keys stay in ignored local `work/` files.

Both providers receive the same Role and Risk evidence, prompts, JSON schemas, policy, and candidate IDs 0–39. Their request hashes are compared before rating differences are interpreted. Red-Team receives each provider's own compiled draft, so that stage's user message can differ. Each provider supplies one specialist observation per stage; the three stages are not three independent votes. A model timeout, 429 or schema error is reported as an incomplete review, never as a candidate rejection.

The production contract keeps its bounded stage timeout. `scripts/prepare-committee-comparison.py` copies the checked-in code to a local `work/` runtime and labels the copy `research-40-v1`, `SIMULATION`, with a longer deadline. The script records each copied file hash and each permitted modification. The research runtime refuses non-local, online or non-strict runs. The extended deadline and research manifest cannot be used as a production approval.

To reproduce, place provider keys in ignored local environment files; do not put them in the command or GitHub. Use one frozen inputs file and one complete reads cache for both runs:

```sh
python3 scripts/prepare-committee-comparison.py work/my-comparison/runtime --finalists 40 --deadline-ms 300000
bun --env-file=/path/to/private-openai.env run work/my-comparison/runtime/packages/backend/scripts/strict-gate-check.ts \
  --provider openai --model gpt-6-sol --finalists 40 --gate strict --offline --serial --timeout-ms 300000 \
  --inputs /path/to/inputs.json --reads /path/to/reads.json --as-of 2026-10-07T05:51:45Z \
  --local-dir work/my-comparison/openai-db --output work/my-comparison/openai.json
bun --env-file=/path/to/private-kimi.env run work/my-comparison/runtime/packages/backend/scripts/strict-gate-check.ts \
  --provider kimi --model kimi-k3 --finalists 40 --gate strict --offline --serial --timeout-ms 300000 \
  --inputs /path/to/inputs.json --reads /path/to/reads.json --as-of 2026-10-07T05:51:45Z \
  --local-dir work/my-comparison/kimi-db --output work/my-comparison/kimi.json
python3 scripts/summarize-committee-comparison.py \
  work/my-comparison/openai.json work/my-comparison/kimi.json work/my-comparison/comparison.json
```

The summarizer checks matched evidence and prompt hashes, then compares candidate checks, manifest status, source count, token use and latency without exporting wallets or holdings. A single cohort cannot establish which model is more accurate, safer or more profitable. The production deployment and a sustained 10-minute cadence require separate verification.

## Observed local run, 2026-10-07

| Measure | GPT-6 Sol | Kimi K3 |
|---|---:|---:|
| Matched finalists | 40 | 40 |
| Role + Risk ratings complete | Yes | No |
| Candidate checks passed | 5/40 | Unavailable |
| Committee-selected sources | 3 | Unavailable |
| Frozen/live sources | 0 | 0 |
| Model stages returned | Role, Risk, Red-Team | None |
| Provider error | None in the complete replay | HTTP 429, organization concurrency limit 1 |

The OpenAI requests returned in **52.7 s, 47.5 s and 47.6 s**, with **246,339 prompt tokens** (including 246,330 cache-write tokens) and **11,313 completion tokens**. At the [published GPT-6 Sol text-token rates](https://developers.openai.com/api/docs/models/gpt-6-sol), this successful three-stage run is roughly **$0.73** before any billing adjustments; the platform billing page is authoritative. An earlier 60-second attempt completed only Role and may incur an additional charge. The 180-second production stage bound is based on these observed timings; its 10-minute scheduling behavior remains unverified on Vercel.

The same frozen evidence and Role/Risk request hashes matched across providers. Kimi returned 429 before any rating, including after bounded retries; it supplied no token usage or candidate verdict. The local database initially rejected the newer `benched` status because its harness applied only the old selection migration. After the harness copied the current roster status constraint, a validated replay of the three paid OpenAI outputs completed as **`benched`**, with **3/3 approved sources passing the hold gate**. The frozen configuration still required at least five sources, so **no live admission or order occurred**. A separate Kimi rating comparison remains open until its organization concurrency slot is available.

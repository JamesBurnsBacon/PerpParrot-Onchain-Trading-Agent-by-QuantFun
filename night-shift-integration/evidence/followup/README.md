# Follow-up evidence, 7 October 2026

Start with ../../FOLLOWUP_REPORT.md. The controlled/ and demo/ folders above show the complete successful pipeline on synthetic inputs. This folder records separate measured results.

- measured/: 25 real public Score finalists, raw archive verification, rule receipts, per-account failed gates and dashboard funnel. Both rules reject the cohort.
- provider/: actual pinned GPT-4.1 mini and GPT-4.1 Role/Risk results, four validated audit records, offline verification and five tamper checks. Both reviews reject the cohort. Red-Team, freeze and executor were not reached.
- accelerated-ingest.json: production ingestion code with a logical clock and synthetic API responses; 20 checks include child-process restart, replacement, re-entry and quota handling.
- observed-worker-history.json: real existing-worker history, including failure/missing slots. This worker still runs the older branch.
- downloads.json: exact immutable model input and public raw/normalized Score data release assets with SHA-256 hashes.
- final-code-ci.json: all five code checks passed at the final implementation commit, including the offline provider verifier. Supabase Preview is skipped.
- implementation-verification.json: local tests and CI from the implementation commit it names; later code changes are only the offline provider verifier.
- team-update.json and preview-health.json: latest checked teammate references and the hosted-health verification limit.

Recheck every file and the controlled pipeline from the repository root:

    bun --no-env-file night-shift-integration/verify-evidence.ts

Download the exact input named in downloads.json, then independently verify actual model outputs without another API call:

    bun --no-env-file night-shift-integration/verify-provider.ts --input /path/to/measured-review-input-20261006T200556Z.json --results night-shift-integration/evidence/followup/provider --out /tmp/provider-verification.json

HTTP status/call count are runner metadata; the hashes check internal consistency, not provider signatures. No credentials, raw provider requests, wallet keys or private service databases are included.

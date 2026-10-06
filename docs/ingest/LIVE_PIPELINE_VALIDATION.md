# Live pipeline validation — 2026-10-06

The complete regular research cohort was checked before selecting these accounts. Score uses the repository defaults, including `allowUnknown: []`.

- First-pass addresses: **20,869**; regular candidates checked: **10,987**.
- Known filter failures excluded before extra fetching: **53**.
- Exported Score inputs: **10,934**; strict eligible: **7,296**.
- Exported Top 100 matches the database initial selection in exactly the same order.

## Two consecutive official-API cycles

| UTC bucket | Accounts | Total seconds, including ranking | Requests | Retries / 429s |
| --- | ---: | ---: | ---: | --- |
| 15:30 | 100 | 144.168 | 100 | 0 / 0 |
| 15:40 | 100 | 138.655 | 100 | 0 / 0 |

The second cycle used exactly the first cycle’s `nextSelection`. All 200 input addresses, request bodies and original response hashes matched their corresponding slots. Both batches contain 100 strict-eligible refreshed inputs. The initial 15:20 startup job was interrupted by an operator restart and published nothing; the two measured complete batches began at 15:30 and 15:40.

## Native CRE simulation

The native CLI simulation passed with default resource limits enabled. It requested the 15:40 job idempotently and verified the fixed 15:30 publication. Its result was `previous-batch-verified-current-requested`; both run IDs and receipt/artifact hashes are recorded in the release.

```bash
cre workflow simulate ingest-cycle --target local-simulation --non-interactive --trigger-index 0
```

Workflow binary SHA-256: `5bc3cf684054518c8ce3bf823ce567f9646176d3996090ee4659d7d7ecc1cfa2`.

## Recovery and reproducibility

- A separate verified-subset live probe was killed after 20 durable records. Recovery reused those 20 and completed the other 80. There were 101 request attempts: 100 successful responses and one interrupted attempt, with exactly 100 final account records.
- All 20,869 original research rows replayed without a mismatch. Changing response arrival order produced the same canonical output.
- Backend: 410 tests and typecheck pass. CRE workflow: 5 tests and typecheck pass. Native WASM compilation and simulation also pass.

Download `pipeline-validation.json`, `live-cycles.jsonl.gz` and `live-cycle-evidence.jsonl.gz` from the [data release](https://github.com/JamesBurnsBacon/PerpParrot-Onchain-Trading-Agent-by-QuantFun/releases/tag/score-data-2026-10-06). The manifest and checksum file cover the exported inputs and evidence.

These are measured local integration runs, not a long-duration reliability study or a DON deployment. The supervised worker continues every ten minutes while the local host is running. The ranking uses fresh stored registry observations; accounts outside the refreshed 100 need a broader refresh before their 24-hour cache limit expires.

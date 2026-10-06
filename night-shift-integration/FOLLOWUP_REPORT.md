# Hackathon follow-up — 7 October 2026

The delivery uses bounded real runs and accelerated failure/restart tests. It does
not require a 24-hour wait or claim long-term hosted availability. The earlier
controlled demonstration remains documented in `DELIVERY_REPORT.md`.

## Implemented

- Idle refresh rotates older candidates under the same worker lease and API quota.
  Refresh and ranking progress survive interruption. Quarantined accounts need a
  successful probe to regain eligibility.
- A failed account can be replaced by a fresh strict-Score candidate. The original
  list, effective list, reason and ranking hash are persisted before acquisition;
  publication still requires 100 eligible accounts.
- Measured inputs bind exact public API responses, account/DEX/request identity,
  fill coverage and the original Top 100 artifact. Spot fills are excluded from
  perp measurements; repeated `tid=0` events use execution identity.
- Both simple rules consume one immutable prepared frame through the existing
  Review/SQL interfaces. Mandatory policy gates are unchanged. Research finalists
  remain `picked=false` until Review/freeze succeeds.

## Final executed evidence

| Evidence | Verified result and boundary |
|---|---|
| Measured archive | 25 accounts, 76 readsets: 73 complete all-DEX and 3 legacy incomplete reads; 96 retained fill pages, 936 raw files, 984 archived request/response bindings. The bindings cover the archive, not only its latest refresh. |
| Two deterministic rules | Both returned `INVALID_BUCKET / INSUFFICIENT_EVIDENCE`; zero frozen sources. Final diagnostics: 9 holding periods below one hour, 16 unknown holding periods, **23** execution-fit failures. Reasons overlap. |
| Actual model committee | [Workflow 37524055099](https://github.com/JamesBurnsBacon/PerpParrot-Onchain-Trading-Agent-by-QuantFun/actions/runs/37524055099) succeeded: `gpt-4.1-mini-2025-04-14` and `gpt-4.1-2025-04-14`, Role + Risk each, 4 HTTP 200 calls, 0 retries. Both returned `INVALID_BUCKET / INSUFFICIENT_EVIDENCE`. **No Red-Team, freeze or executor ran on this provider path.** |
| Offline provider verification | 4 audit records verified against the immutable input, versioned prompts, output/record hashes, exact receipt audit IDs and receipt/manifest commitments. Five temporary-copy tamper checks were rejected. HTTP status/call count remains runner metadata, not provider-signed proof. |
| Existing worker, observed around 04:17 +08 | 4.72 hours observed: 28 attempts, 27 complete, 1 failed, 2 missing schedule buckets. All 27 publications contain 100 unique accounts and valid hashes. Complete-run durations: 137.203 / 138.655 / 632.651 seconds minimum / median / maximum; 12 consecutive timely buckets at the tail. This worker still uses the prior code version. |
| Controlled full chain | Synthetic source responses and deterministic Review adapters exercise actual Score, Review, freeze, HTTP targets, executor dry-run, SQL persistence, deduplication and recovery. Its successful execution is separate from the real-data rejection above. |

At code commit `4b75b59`, CI verification, backend, executor, dashboard and offline
proof all passed. The regenerated accelerated harness passed 20 checks in 6.011
seconds. Controlled-chain verification checked 54 files against code hash
`3a1abe27072cacfebcef58d6aee0ad91dc8ae17dd7a36766fef9591bd7cc3b74`.

The final archive and checksums are listed in `MEASURED_PIPELINE.md`. Provider
verification is in `evidence/followup/provider/verification.json`; negative checks are in
`tamper-checks.json`. High Score alone did not establish current copyability.

## Remaining work for the team

1. Inspect measured diagnostics and obtain suitable copyable perp candidates with
   sufficient evidence. Do not substitute spot performance, configured leverage or
   guessed holding times for missing facts.
2. Historical holdouts use a cohort selected today. Two committees on one snapshot
   do not establish a model winner; prospective evaluation remains.
3. Deploy services/schema and verify authenticated health, repeat dry runs,
   persistence, alerts and recovery there. Vercel preview health requests currently
   redirect to login; build success is insufficient.
4. Review before operational cutover. Rotation/recovery has isolated evidence;
   the original local worker has not been replaced.

GitHub was checked at 04:18 +08: PR #32 (`af7e857`), #30 (`5a4f0fd`) and #31
(`afc8358`) remained open; no new manual comments were found. No real order, wallet
change or production freeze occurred. Original code/database backups remain.

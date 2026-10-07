# Fix: a failed strict review falls back to approving almost everyone

**For:** Bradley. **Status:** fix implemented on this PR branch; not deployed. **Found:** 2026-10-07, before go-live.

## What happened

The roster's bench is built from each review of Score's 25 picks (`review()` in
`packages/backend/src/pipeline/index.ts`, the `const approved =` block). Three reviews of the same
250-account qualified list:

| Run | Started (UTC) | Review core manifest | Path taken | Wallets approved |
|---|---|---|---|---|
| 7 | 09:34 | `VALID` / `OK` | strict: the manifest's sources | 3 |
| 8 | 10:54 | `VALID` / `OK` | strict | 4 |
| 9 | 11:04 | `INVALID_BUCKET` / `POLICY_VIOLATION` | **basic fallback** | **24 of 25** |

No code changed between runs 8 and 9 (same deploy). The models' outputs vary between runs, and in
run 9 the committee proposed a portfolio that broke the bucket policy.

## Why

```ts
const approved =
  manifest.status === "VALID"
    ? manifest.sources.map(...)                 // strict: the 3–4 wallets the committee chose
    : this.o.gate === "strict"
      ? []
      : approvedCandidates(...);                // basic: everyone not rejected
```

- **Any** manifest status other than `VALID` takes the basic path when `REVIEW_GATE` isn't
  `strict` (the default is `basic`).
- `approvedCandidates` keeps every candidate whose Role `reject` is under `riskRejectThreshold`
  (80), with no Risk score above 80 and fit > 0. Nearly all 25 pass.
- The basic gate was meant for **`INSUFFICIENT_EVIDENCE`**: the frame had no measured
  out-of-sample or execution evidence, so the core couldn't pass anyone. Measured evidence now
  exists and strict reviews succeed. A `POLICY_VIOLATION` means the core *did* assess the wallets
  and the proposed portfolio broke a rule, so it shouldn't widen the bench.

## Effect

- The fresh start at 11:16 seated 5 wallets. 3 had strict approvals (`0x2bd6…`, `0x5a72…`,
  `0xcdf6…`), but `0x5df9…` and `0x79b6…` were approved only by the run 9 fallback.
- The bench held about 20 more fallback approvals, which the roster would seat at 2 an hour toward
  12–15.

## Fix

1. **Fall back only on missing evidence.** Use `approvedCandidates` only when
   `manifest.reason === "INSUFFICIENT_EVIDENCE"`, with `REVIEW_GATE=basic`. Any other non-`VALID`
   result (`POLICY_VIOLATION`, `INVALID_BUCKET`, a model error) approves no one. Record it as
   reviewed-and-not-approved. The bench query must include `rejected` runs as well as `benched`
   runs; otherwise a zero-approval review cannot take earlier approvals off (ROSTER.md §4.1).
2. **Record the path.** Store which path produced the bench (`review.gate`: `strict` / `basic` /
   `none`) and the manifest reason on the run, and show it on the dashboard's pipeline panel, so a
   lenient bench is visible.
   A seat re-review with `gate: none` is an incomplete review, not a lost-approval
   verdict: preserve the seats and retry after the failed-review cooldown.
3. **Optional:** a policy violation is often a single seat or weight over a limit. Consider asking
   the committee to repair the portfolio once (the reason is in the receipt) before giving up.

## Tests (Postgres, both `TEST_PG_PREPARE` modes)

- A review whose manifest is `POLICY_VIOLATION` approves no one with the default gate, and its
  verdicts take earlier approvals of those wallets off the bench.
- `INSUFFICIENT_EVIDENCE` with `REVIEW_GATE=basic` still uses `approvedCandidates`.
- `VALID` is unchanged: the manifest's sources only.
- The dashboard labels the actual `strict`, `basic`, or `none` path and the manifest reason.

## Interim (owner's call)

- Setting `REVIEW_GATE=strict` in Vercel (Production) and redeploying stops fallback approvals now,
  with no code change. The bench then grows only from `VALID` reviews, 3–4 at a time.
- `0x5df9…` and `0x79b6…` stay seated until the 12-hourly seat review (ROSTER.md §4.4), unless
  the roster is fresh-started again.

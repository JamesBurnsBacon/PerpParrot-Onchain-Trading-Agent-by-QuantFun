# Historical review-core pressure test

This records the original local contribution before production pipeline integration.
The findings below retain their original test scope and counts. For current behavior
and deployment checks, use [PRODUCTION_INTEGRATION.md](PRODUCTION_INTEGRATION.md).

Scope: the local ai-agent-workflow contribution, including strict contracts, review
orchestration, commitments and persisted-manifest authorization. No live trades,
deployment or real model calls were used. This is a targeted adversarial review, not a proof that
all possible defects have been found.

| Finding | Fix and evidence |
|---|---|
| Repeated observations could inflate quorum | Require configured roster and unique node identities; duplicate/unknown-node tests across all three specialists |
| Async work could finish after evidence expiry | Monotonic injected clock and freshness checks after each stage and at issuance |
| Hung model promise could block indefinitely | Per-stage bounded deadline, AbortSignal cancellation, cleared timers; hung-provider regression |
| Caller could mutate frame/policy/address map mid-review | Copy all inputs and roster before the first await; mutation regression |
| Severe critic warning without penalties could still pass | No effective bounded rebuild means INVALID_BUCKET; warning regression |
| Truthy string could satisfy assessment boolean | Require literal true; reject nonfinite exposure and impossible/noninteger capacity |
| Ceiling confidence median could turn 59.5 into eligible 60 | Floor confidence/suitability, ceil risk/rejection; boundary regression |
| Locale-dependent tie-break could differ between nodes | Use deterministic code-unit lexical ordering |
| Hash/input-verification stubs could authorize altered inputs | Internal strict canonical/domain-separated Keccak verification; changed evidence/policy/mapping regressions |
| JSON serialization could silently drop/coerce input | Reject non-JSON objects, undefined, sparse arrays, nonfinite values, cycles and lone surrogates |
| Schema-only persisted manifest could carry invalid allocation | Verify hash, policy hash, cash total, source uniqueness, caps, status and time semantics |
| Paper or unfrozen manifest could be consumed as live authority | Add requireFrozenLiveManifest; simulation and wrong-freeze regressions |
| Unbounded integer timestamps and impossible target-count policy | Safe-integer limits and maximum 10 targets in schemas |
| All-cash draft unnecessarily invoked critic | Return unavailable bucket before critique |

Tests: 29 Node tests, including 150 seeded varied-input scenarios, plus 34 Python
contract shape checks and TypeScript checking. Cryptographic tests use the known
Keccak empty-input vector, insertion-order/domain separation and tampered commitments.
The position-replay assessment remains mocked in unit tests; these results do not
prove trading feasibility or risk-model quality.

## Open items at the time of this review

This is historical context, not the current implementation checklist. Subsequent
work added pipeline review, persistence and executor reconciliation; see the current
integration map above. Research validation remains separate from implementation.

- A real-provider review run and request-size/latency checks against the chosen
  provider are still absent.
- Real position replay, active-source renormalization stress, asset eligibility,
  drift and minimum-order capacity must implement assess. A synthetic pass is not
  acceptable in a live adapter.
- Signing, nonce persistence, cloid reconciliation and transport remain executor
  work. This contribution does not implement them.
- Backtest cut integrity, survivorship disclosures and latency/policy calibration
  need real datasets and replay. Unit fixtures cannot establish investment quality.
- Freeze persistence must be authoritative. Checking a manifest hash supplied by an
  untrusted caller does not establish it as frozen.
- Cancellation cannot preempt synchronous CPU work.
- Node identity is attached by the trusted adapter that makes the model calls. The
  core rejects duplicates but cannot authenticate a fabricated node ID.

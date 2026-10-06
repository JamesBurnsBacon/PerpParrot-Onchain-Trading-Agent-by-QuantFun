# Pressure-test findings and fixes

Scope: the local ai-agent-workflow contribution, including strict contracts, review
orchestration, commitments and persisted-manifest authorization. No live trades or
CRE deployment were used. This is a targeted adversarial review, not a proof that
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

## Remaining implementation gates

- Real CRE capability adapters, authenticated node provenance and installed-SDK
  production-limit/WASM simulation are still absent from upstream.
- Real position replay, active-source renormalization stress, asset eligibility,
  drift and minimum-order capacity must implement assess. A synthetic pass is not
  acceptable in a live adapter.
- Signing, nonce persistence, cloid reconciliation, report signature verification
  and transport remain executor work. This contribution does not implement them.
- Backtest cut integrity, survivorship disclosures and latency/policy calibration
  need real datasets and replay. Unit fixtures cannot establish investment quality.
- Freeze persistence must be authoritative. Checking a manifest hash supplied by an
  untrusted caller does not establish it as frozen.
- Offline timers/AbortController and Ajv compilation must be adapted for CRE's
  runtime. Cancellation cannot preempt synchronous CPU work.
- Node identity is attached by the trusted adapter. The core rejects duplicates but
  cannot authenticate a fabricated node ID without real DON provenance.

## GitHub authentication diagnosis

The connector identifies as badjiallan053-boop. Repository metadata reports push=true
for that account. Nevertheless, GitHub write endpoints returned 403 “Resource not
accessible by integration”; the account's collaborator rights and the application's
credential grants are separate. No GH_TOKEN, GITHUB_TOKEN or GITHUB_PAT was found in
the process environment. Git's repository credential lookup returned no stored GitHub
token. No token values were printed or saved.

The remedy is to reconnect/authorize the GitHub integration with Contents write for
this repository, or configure an authorized local Git credential/SSH account. A
collaborator having push access, or creating a branch in the browser, does not grant
an application's credential write permissions. See GitHub's official
[API troubleshooting](https://docs.github.com/en/rest/using-the-rest-api/troubleshooting-the-rest-api)
and [Git commit permission requirements](https://docs.github.com/en/rest/git/commits).

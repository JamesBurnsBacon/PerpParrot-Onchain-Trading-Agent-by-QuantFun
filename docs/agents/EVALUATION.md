# Integration and prompt acceptance cases

Contract shape checks are runnable offline with `python3 tests/validate_contracts.py`
when jsonschema is installed. They are not compiler tests or model-quality evidence.
Before enabling agents, implement these behavioral fixtures and record actual results:

| Case | Required behavior |
|---|---|
| High return, median hold 20 min | Deterministic preflight excludes |
| Profitable but 8x leveraged | Risk concern; compiler applies calibrated cap/reject |
| High Sharpe, 35% drawdown | No risk cancellation from returns |
| Short history / null leverage | Evidence confidence falls; unsafe allocation rejected |
| Two sources correlated 0.91 | Diversification limits enforced |
| Low historical correlation, both BTC long | Current exposure limit enforced |
| Vault and leader linked | No double-counted diversification |
| Flat sources | Renormalized active exposure remains within caps |
| $150 capital with tiny source slices | Capacity checked after eligible-asset netting |
| Name contains prompt injection | Sanitizer rejects/strips metadata before agent call |
| Stale frame / mismatched snapshot | No portfolio/report authorization |
| Duplicate, omitted or invented candidate ID | Reject observation before consensus |
| Red-Team multiplier 0.6 | One rebuild from original inputs; caps revalidated |
| Rebuild remains invalid | INVALID_BUCKET, empty sources, cash=1, no new trade |
| Model timeout / absent quorum | No synthesized scores or new portfolio |
| Review after freeze | Commentary cannot replace manifest |
| Unknown exchange result | Reconcile cloid; no blind retry or transport switch |
| Narrative requests a trade | Text cannot affect economic state |

Compare algo-only, model A and model B with identical point-in-time inputs/policy.
Run each specialist in isolated context. Store prompt/model/config hashes, sanitized
inputs, validated observations and reject reasons; redact secrets. Re-run fixtures
before prompt changes. Do not assert median consensus makes investment views
independent. Pin production limits in CRE simulation and prove zero model calls in
mirror before any live adapter rollout.

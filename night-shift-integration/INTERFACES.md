# Interfaces to retain when replacing implementations

Baseline: James PR #32 (`af7e857`). No signature/report transport is involved. Production protocols below belong to their existing packages; `night-*` protocols only describe this local proof runner.

| Boundary | Owner / source | Producer → consumer | Required interpretation |
|---|---|---|---|
| Candidate input | `backend/src/score/types.ts` | ingest → Score | Portfolio points `[UTC epoch ms, USD]`; `tradeCount` distinct order evidence; null means unknown. Full cohort ranking precedes Top 100 collection. |
| Score / finalist frame | `backend/src/score/frame.ts`, `review/input.ts` | Score → Review | Use current teammate filters; no relaxed unknowns. Full measured OOS / execution evidence is still required for real accounts. |
| Review / audit | `shared/src/contracts.ts`, `review/committee` | bound evidence → Role, Risk, Red-Team → manifest | Frame 1.1.0; prompt/model/evidence hashes; anonymous model input; schema validation; configured provider quorum 1. Rule adapters here are deterministic test implementations. |
| Freeze | `shared/src/frozen.ts`, `review/paper/lifecycle.ts` | valid reviewed receipt → frozen configuration | Account + chain + policy + source weights committed together. Reopen DB and confirm unchanged hash. After freeze, reviews monitor rather than replace sources. |
| Snapshot | `backend/src/service.ts`, `snapshot.ts`, `shared/snapshot.ts` | frozen sources → immutable per-slot bytes | One `runAt` per 600 seconds; times in seconds at this boundary. `run_snapshots` holds exact bytes, whose keccak is recorded. All source reads must finish. |
| Targets | `shared/copy.ts`, `executor/src/targets.ts` | backend `GET /targets/:runAt` → executor | `runId = mirror-<runAt>`; matching slot, account and frozen configuration hash. `exposureE9` is a signed base-10 integer string: `800000000` means 0.8× equity, not USD. Executor parser converts to bigint. |
| Trigger | `executor/src/app.ts` | cron / admin → Runner | `GET /cron/run` with cron bearer auth; `POST /admin/run` with admin auth. Durable `executor_run_claims` makes duplicate slots no-op. |
| Execution evidence | `executor/src/runner.ts`, `pg-store.ts` | targets + live state → plan → run | Live equity sizes targets. IOC rounding, drift, min order and margin constraints remain unchanged. `dryRun:true` results are simulated. Journal ambiguity pauses further execution. |
| Dashboard | `shared/dashboard.ts`, service read endpoints | stored runs / paper books / artifacts → view | `picked` means a frozen member: research candidates are exported with `picked:false`. Backtest values start at 1; timestamps are milliseconds. Dry-run plans are not realized PnL. |

## Local proof protocol

`night-pipeline.v2` uses a ten-minute millisecond bucket, source timestamp, source SHA-256, code digest and explicit provenance (`REAL_ARCHIVE` or `SYNTHETIC_FIXTURE`). A current `TICK` rejects an old archive. `REPLAY` is a logical clock, never relabeled live.

Every committed stage stores `night-artifact.v1`: run ID, stage, canonical-input hash, body hash, strict validated JSON and `economicAuthority:false`. `night-receipt.v1` records ordered completed stages and their chain digest. No final success receipt is written if a required stage fails.

The local runner retries explicitly classified transient errors only. Deadlines are bounded, and adapters must honor abort signals. A timed-out adapter cannot write a checkpoint, but non-cooperative external work may continue; the runner is not a distributed/exactly-once external side-effect system. Executor claims and journals are separate safety mechanisms.

`night-allocation.v1` remains unchanged: five sources at 0.16 each plus 0.20 cash; weights are fractions. Deterministic address tie-break. Change the algorithm version if semantics change.

`night-module-probe.v2` removes the old ABI fields, adds a typed `serviceProof`, and binds the reviewed frozen configuration directly to the backend/executor demonstration. Fixture values only exist in that explicit lane. No synthetic execution or OOS values are written into real archive inputs.

## Schedules and distinct sets

- **Ingest universe:** about 10,000 regular research candidates with retained evidence; rank the entire usable pool with current Score.
- **Every ten minutes:** refresh portfolios for the selected Top 100, persist an immutable batch and receipt, then re-score. The same account legitimately appears in successive snapshots; duplicate work within a bucket is recovered or reused.
- **Review/freeze:** separate decision stage. Top 100 collection does not automatically replace the frozen 5–25 copy sources.
- **Positions mirror:** James's `:x9` snapshot and `:x0` executor job refresh only frozen sources' positions and execute their target exposures in dry-run until explicitly enabled by an operator.

## Replaceable implementations

Change the selection rule behind `allocate()`, model adapters behind the Review dependency interface, or hosting around these ordinary services. Keep the schemas, units, commitments, provenance and failure behavior. Persist schema migrations before enabling services using renamed tables. No production database migration or deployment is performed by this demo.

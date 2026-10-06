# Delivery evidence — 2026-10-07

This branch integrates the new service interfaces from James's PR #32 (`af7e857`),
Bradley's ordinary Top 100 ingest from PR #31, Masa's current Score, and the team's
Review / audit / freeze modules. The algorithms remain two simple deterministic rules.

Evidence is versioned under `evidence/`; `manifest.json` binds the implementation
commit, code digest, collection time and SHA-256 of every exported file. Run:

```sh
bun --no-env-file night-shift-integration/verify-evidence.ts
```

The verifier independently checks the reviewed receipt commitment, frozen configuration,
exact snapshot bytes, recomputed exposures and stored dry-run results, beyond file checksums.

## Final local result

Implementation commit: `9e80758a65700f869866330e6a6c224e806ae673`. Evidence collected at **2026-10-07T02:47:48.005632+08:00**.

| Check | Result |
|---|---|
| Backend tests | 412 passed, 0 failed |
| Executor tests | 76 passed, 0 failed; 1 Postgres advisory-lock check skipped locally |
| Night integration | 8 passed, 50 assertions |
| Root / contracts | 11 Node test files passed; 34 JSON schema checks |
| TypeScript | root, backend, executor, night integration passed |
| Dashboard | production build passed |
| Full real archive | 10,934 inputs; 8 complete A/B window evaluations; 2 logical buckets |
| Re-run / recovery | all 5 stages reused per bucket; interrupted run reused 2; final chain matched clean run |
| Evidence integrity | 36 run JSON checksums checked; exported bundle verifier passed |
| Independent audit | Runner regression and complete exported evidence independently re-verified |

One local PostgreSQL network/advisory-lock test required a server and was skipped; Service checks CI includes PostgreSQL. The HTML was generated; automatic local-file browser preview was unavailable because the app forbids `file://`.

## Live data observed this night

- Official API Top 100 cycle completed **2026-10-07 02:37:22 +08:00**.
- **100 successful / 0 failed**, all 100 strict Score eligible; next selection has 100 accounts.
- **137.577 seconds**, 100 requests, **0 retries / 0 rate limits**; no external writes or orders.
- Isolated registry: 10,987 accounts. Current Score code and target-set hashes are in the receipt.
- Original worker stayed active on its old checkout; this rehearsal ran during its idle period.
- James's actual backend/executor process smoke passed all five scenarios against public live
  Hyperliquid reads: executed dry-run, paused, backend unavailable, wrong configuration, duplicate.
  Default smoke storage is memory; durable SQL evidence comes from the separate controlled proof.

## Controlled complete chain

Both rule adapters feed production Score and Review, persist three audit rows, freeze,
reopen the paper database and enter monitoring-only. That same frozen configuration feeds
SnapshotService → HTTP targets → executor app / Runner → actual SQL stores → public run view.

Each service proof exercises 12 scenarios and 15 checks, including a fresh concurrent
claim race, duplicate after database reopen, snapshot hash identity, paper persistence,
wrong account/configuration/expired slot, backend failure, and database faults before
dispatch and after leverage / final IOC responses. Recovery requires reconciliation and
explicit resume, and then completes the next dry-run. The SQL engine is local PGlite with
production queries/migrations; this does not establish Supabase hosting, Bun's Postgres
network driver, pooler or cross-process advisory locking.

A regression found and fixed: if the last IOC result failed to persist, no unsent tail
existed, so a run could be labeled executed. Runner now records failed, retains observed
results, attempts a durable pause, and leaves the journal for recovery. Tests also cover
failure to persist that pause: the unresolved journal still blocks the next run.

## Historical baseline and execution limits

The separate public archive contains 10,934 Score inputs. A/B evaluations use 14 / 30 /
42 / 90-day windows and the cached BTC benchmark. Historical selection has survivorship
bias and coarse observations; outputs are research integration evidence, not an approved
investment strategy. The controlled complete-chain accounts are synthetic, and its model
adapters are rules, not billable LLM calls. Real-account Review evidence remains to be measured.

No real exchange order, production database migration, cloud deployment, funded canary or
real-model experiment is performed here. Successful final test/replay summaries and exact
commit identifiers are recorded in `evidence/verification.json` after the final run.

## Preservation

Work started at 02:26:44 +08; the pre-change backup was recorded at 02:27:27 +08.
The local archive contains 36,384 files (~279 MB), Git bundle and per-worktree patches,
with checksums. Five original worktrees and the existing collection service remain in place.
The backup is local and is not part of this public evidence bundle.

The live database additionally received a read-only online backup at **02:44:24 +08** (2,121,584,640 bytes; quick_check=ok), kept locally with its SHA-256.

# Ingest handoff: ordinary backend job

This ports Bradley's tested Top 100 acquisition worker from PR #31 (`afc8358`) onto
James's service architecture (`af7e857`). It imports the **current checkout's**
`src/score` functions. No Score formula, filters, thresholds or portfolio policy
are changed.

## Run it

Install the root dependencies and backend dependencies first (Node 24, pnpm, Bun
1.4.2). From `packages/backend`:

```sh
# Start from GitHub alone: manifest + three hash-verified compressed assets.
# About 470 MB compressed. No Bradley SQLite database or machine paths are needed.
gh release download score-data-2026-10-06 \
  --repo JamesBurnsBacon/PerpParrot-Onchain-Trading-Agent-by-QuantFun \
  --dir data/release-2026-10-06 \
  --pattern manifest.json --pattern discovery.jsonl.gz \
  --pattern score-inputs.jsonl.gz --pattern score-evidence.jsonl.gz
bun --no-env-file src/ingest/loop/once.ts \
  --db data/rehearsal/loop.sqlite \
  --import-release data/release-2026-10-06 --import-only

# If import says ready:false, its original observations are too old or fewer than
# 100 fresh accounts pass. Refresh up to 100 stale accounts through official APIs.
# Repeat on the SAME database until ready:true; each successful account is saved.
bun --no-env-file src/ingest/loop/once.ts \
  --db data/rehearsal/loop.sqlite --refresh-stale --refresh-limit 100 --import-only

# One real, read-only Hyperliquid API cycle; no orders and no remote DB writes.
bun --no-env-file src/ingest/loop/once.ts \
  --db data/rehearsal/loop.sqlite --out data/rehearsal/proof

# Optional single-host worker: ten-minute Top 100 + automatic idle candidate refresh.
# Stop the old worker before replacing it; do not run two collectors on one budget.
INGEST_LOOP_DB=data/rehearsal/loop.sqlite INGEST_LOOP_PORT=8791 \
  bun --no-env-file src/ingest/loop/server.ts

bun run test:ingest
bunx tsc --noEmit
```

The portable import verifies compressed-byte hashes and row counts, joins discovery,
Score inputs and raw portfolio/fill evidence by address, verifies the response hashes
and input/evidence agreement, and keeps the **original** observation timestamps.
It records the release's manifest hash and old Score commit separately from the
current Score source hash. It imports 10,934 verified-input rows from the historical
release; the 53 excluded-before-evidence rows are not fabricated or promoted.

An archive older than 24 hours remains `ready:false`. Its historical Score order is
only the priority for refreshing accounts. Official refresh rechecks current
portfolio, stale classification and vault status, and preserves unknown evidence.
Once at least 100 freshly observed accounts pass current strict Score, the worker
can start. `selectionScope: fresh-subset-of-imported-registry` explicitly means
Top 100 **among the refreshed eligible subset**, not a new scan of all 10,934 accounts.
Continue refresh calls to broaden coverage; `freshAccounts` and `totalAccounts`
report the coverage. The 24-hour freshness filter is never relaxed.

For a local operator who already has a registry, `--import-from EXISTING.sqlite`
is an alternative to `--import-release`; its SQLite source is opened read-only.
Neither import copies a live worker's lease, pending requests, publications or old
selected order. Invalid imports cannot mark the destination ready; inspect their
failure and use a new destination. A valid stale portable import is retained and
can be refreshed in place with the command above.

The CLI's `--out` contains **aggregate proof only**, safe for the GitHub handoff:
`ingest-validation.json` and its checksum. The SQLite database, raw responses,
addresses, request bodies and the full local artifact are not published by this
command. The default Git ignore excludes `packages/backend/data/`.

## Contract and behavior

- Input universe: previously screened regular research candidates with bootstrapped
  account classification and filled-order evidence. Imported evidence is checked;
  optional Score/Review evidence is never filled with invented values.
- Selection: current `scoreCandidates`, default strict config (`allowUnknown: []`),
  first 100 eligible ranked candidates whose portfolio was fetched within 24 hours.
  These 100 **acquisition accounts are separate from the trading finalists**.
- Every cycle: freeze those 100 addresses for that bucket; fetch their current
  official portfolio; update equity and normalized history; refresh stale account
  classification and vault state; fetch order evidence only when insufficient.
  Rank the registry again for the next bucket using the same Score implementation.
- A collection failure or new strict-Score failure can replace that slot with the
  highest ranked unused **fresh, strict-eligible** account. Every replacement is
  fetched and checked before use; no eligibility filter is relaxed. At most 20
  replacements are attempted per run. If 100 valid accounts cannot be obtained,
  the previous complete publication remains authoritative.
- Output: immutable `ingest-cycle.v1` artifact containing `inputs: ScoreInput[]`,
  the current-batch Score result, `nextSelection`, timestamps, raw evidence hashes,
  Score source/config hashes and request outcomes. Scores in this artifact are
  explicitly scoped to the refreshed batch; `nextSelection` ranks the registry.
  `originalSelection` is the frozen requested list; `effectiveSelection` and the
  backward-compatible `selected` field describe the actual 100 inputs.
  `substitutions` records each slot, old/new address, reason, time and complete
  ranking hash. `accountFailures` preserves failed attempts. A substitution is
  committed before its replacement request, so restart resumes that exact slot.
  Receipts include both lists. Publication verifies the substitution chain.
- Success requires 100 distinct collected accounts, fresh responses and a complete
  next strict selection. A partial run retains its per-account checkpoints but
  never replaces the previous complete publication.
- SQLite WAL/FULL durability, a renewable owner-fenced lease, bounded requests and
  retries, a nine-minute deadline, and duplicate bucket IDs support local recovery.
  An expired worker cannot publish after another worker acquires the lease.
- Official API request weight is limited to 800 units per rolling minute in this
  database; the public IP quota is shared with other applications. Separate SQLite
  files do **not** coordinate the IP budget. Run rehearsals outside the existing
  worker's active collection window. Use one worker for normal operation.

Consumers can use the loopback worker's `GET /ingest/latest`, then the returned
`artifactHash` at `GET /ingest/artifacts/:hash`. `GET /ingest/runs/:runId/publication`
returns that exact bucket, even after a newer bucket is published. Only committed
artifacts are served; no generic raw-blob download exists. `/ingest/latest` returns
503 when the last complete result is older than 15 minutes.

## Automatic candidate rotation and quarantine

The long-running worker gives the Top 100 cycle priority. Between cycles it visits
other candidates whose portfolio is at least one hour old. The order is the oldest
of each candidate's last observation/attempt time first, with address tie-breaking.
Successful observations and attempted visits are durable; a restart resumes fair
rotation instead of starting at the same address again. Accounts older than 24
hours are re-fetched and can re-enter current Score; the freshness rule stays intact.

Each background slice is bounded to **20 accounts or 45 seconds**, whichever comes
first. No new background slice/request starts in the final **60 seconds** before
the next ten-minute slot. These are work/deadline limits, not a narrower research
universe. The same SQLite owner lease, collector and rolling API-weight budget
serve both jobs. A foreground trigger cancels the same worker's background task,
waits for it to release the lease, and starts the Top 100. Cancellation and deadline
preemption do not count as account failures. `/health` reports background totals,
the last slice and the quarantine count.

Each saved refresh also marks ranking pending. If cancellation or the slice
deadline interrupts ranking, the next background slice first retries that ranking
without new API requests. The flag survives restart, so saved observations cannot
be stranded just because the collection queue later becomes empty.

Two consecutive completed collection failures quarantine an account for 30 minutes.
Further failed probes back off to 1, 2, 4 and at most 6 hours. Cooldown expiry permits
a new API probe; it does **not** promote the old failed cache. Only successful fresh
collection clears the consecutive-failure state. Lifetime failure counts remain
in `account_health`. A single bad account therefore cannot repeatedly block the
entire batch or monopolize background rotation. Unknown or unprofitable accounts
remain subject to the unchanged Score filters after collection.

If a foreground batch cannot find a fresh strict replacement, a durable
`foregroundNeedsRefresh` marker suspends foreground retries while the bounded
background slices repair the registry. Previously selected accounts are not
protected during this catch-up. A failed cache stays excluded until a successful
fresh read; simply having its old Score is insufficient. Catch-up may probe a failed
recent account after 60 seconds without waiting for the ordinary one-hour refresh
age (quarantine still applies). Once the registry again
contains 100 eligible fresh accounts, normal scheduling resumes. The pending run
keeps its original selection and records any substitution; if its two-slot resume
window expires, the next current slot starts from the repaired selection. This
prevents repeated failed batches from starving refresh after a long outage.

The one-shot CLI runs a single foreground cycle; automatic idle refresh belongs to
the long-running worker. The earlier SQLite file remains readable: new health
tables and run fields are additive. Existing artifacts with no substitutions retain
their original meaning. Separate database files still do not coordinate an IP quota.

## Boundary with James's services

`ingest-cycle.v1` supplies **Score inputs**. It is not a positions snapshot and
cannot authorize trading. AI Review, evidence validation and an explicit freeze
still produce the configuration consumed by the independent mirror path:

```text
regular candidates → Top 100 portfolio ingest → Score → Review → frozen configuration
                                                        ↓
Hyperliquid positions → backend /targets/:runAt → executor dry run → recorded run
```

The mirror uses `run_snapshots`, `eligibility_state`, `executor_run_claims` and
`executor_runs.evidence` from James's migration. This local acquisition worker uses
its separate SQLite registry, so it neither recreates old tables nor changes that
migration. No native-workflow simulation or signed report path is involved.

The worker binds to `127.0.0.1`. For a hosted job, use a supervised worker/AWS task
with persistent storage. A multi-host or ephemeral-function deployment needs a
shared database/lease/budget adapter and authenticated trigger transport first;
this local SQLite worker does not claim those deployment properties. The existing
service CI runs the ingest tests alongside backend tests with root dependencies
installed.

## Verification scope

The ingest tests cover restart/resume, partial publication, duplicate triggers,
lease fencing, stale or corrupt evidence, fixed-bucket reads, cancellation,
rate-limit backoff and order-count semantics. Registry import tests additionally
check read-only source preservation, evidence disagreement, portable release-only
initialization, corrupt/future evidence rejection, and resumable refresh of an
expired archive without changing historical timestamps or promoting stale inputs.
Rotation tests use a simulated 25-hour clock advance, process/store restart,
foreground cancellation, a persistent bad account with a recorded replacement,
rejection of stale/unknown replacements, and two database connections contending
for the same quota/lease. This is accelerated failure testing, not a claimed
24-hour production soak.
The live rehearsal's timestamp and measured results are in the aggregate proof,
not inferred from unit-test fixtures. Hosted deployment and funded execution are
separate checks; neither is performed by these commands.

# Scheduled ingest → Score → strategy analysis

The October 7 offline agreement supersedes the timing and budget in [PR #35](https://github.com/JamesBurnsBacon/PerpParrot-Onchain-Trading-Agent-by-QuantFun/pull/35):
**refresh the full candidate registry within 12 hours; refresh up to 200 high-scoring sources every 10 minutes; send up to 25 Score finalists to an Agent.**
Both **ordinary accounts and vaults** participate at every stage. This retains James's Postgres/Vercel design, existing Score implementation and dashboard contract.
It replaces the old SQLite Top 100 collector; historical research and backups are retained.

## Schedule and handoff

| Job | UTC trigger | Result |
| --- | --- | --- |
| `/cron/discover` | 00:15 and 12:15 | Replace the active registry using the official leaderboard and HyperCore vault list |
| `/cron/refresh` | Every 5 minutes | Four workers refresh due portfolios, up to 280 seconds; resume from persisted timestamps |
| `/cron/priority` | Every 10 minutes | Score the cached population, refresh up to 200 distinct high-scoring sources, then invoke selection in the same bucket |
| `/cron/select` | After a complete priority cohort; manual retry available | Re-score that refreshed cohort; persist up to 25 finalists, the dashboard funnel and an Agent job atomically |
| `/cron/agent` | Minutes 04, 09, 14, …, 59 | Process one fresh queued finalist batch, fetch current positions and request structured strategy analysis |

The five-minute refresh invocation is a resumable worker, **not** another population-refresh requirement. Its operating target is that all active sources stay within 12 hours.
Background portfolios become due at 11 hours, leaving time before the 12-hour freshness limit. Initial screening evidence retains its original timestamp. **No scheduled job requests `userFills` or `userFillsByTime`.**
Priority network work has a four-minute envelope after ranking; the full priority handler is bounded at eight minutes inside a 600-second Vercel function.
All routes use `/api/backend` on Vercel and require `Authorization: Bearer $CRON_SECRET`.
The existing positions-mirror cron and executor's dry-run defaults remain unchanged.

Score ranks traders and vaults in separate percentile pools, then applies its existing proportional slot allocation and clone/leader deduplication.
Both pools with eligible distinct representatives receive a slot under Score's default allocation. No artificial 100/100 split is imposed.
When fewer than 200 or 25 sources qualify, the actual count is published; excluded sources are not added to fill seats.
`score_runs.coverage.cohortPools` and `finalistPools` expose the trader/vault counts. The funnel and model evidence preserve each source's kind.

## Input rules and evidence

- Discovery uses equity/TVL ≥ $10,000, positive month **and** all-time PnL. Vault PnL is the last minus first point in the source series.
  Closed/child vaults are excluded. This is the active registry's scope, not every Hyperliquid address or every historical research candidate.
  Empty/malformed discovery retains the previous registry; removed addresses keep their saved history.
- HyperCore vault identity comes from the vault list. Unknown leaderboard entries receive cached HyperEVM code/ERC-4626 probes.
  ERC-4626 probes are a classification heuristic; they do not establish closed status, which remains unknown to Score.
- Store the latest `month`/`allTime` portfolios and up to 90 days of normalized month points. Check PnL baselines, shared points, timestamps and account values.
  Conflicting overlapping history discards older accumulated points and records a flag rather than inventing a continuous curve.
- Fill evidence is collected only for initial screening and reused from the preserved research cache. It does not expire into an automatic re-fetch task.
  The observed distinct perp `(coin, oid)` order count is a durable lower bound for Score's `minTrades` gate; fewer than ten observations from incomplete history stay unknown.
  Spot executions and partial-fill duplicates do not inflate the count. The import validates raw hashes and retains original observation times.
- Initial history does not establish current 30-day maker share or current holding duration. Those fields remain unknown unless existing evidence satisfies their recent-window contract.
  They are never invented from the order-count proof. The Agent receives the dated baseline and its flags.
- Periodic refresh updates only portfolio history (plus classification for new unknown addresses), preserving the initial evidence unchanged.
  Missing initial trade evidence remains unknown to Score and can be handled separately in an explicitly requested research/bootstrap pass; crons cannot silently resume that research.
- Require ≥95% of the active registry to have valid, classified portfolios with both fetch and source endpoint timestamps within 12 hours before choosing the 200.
  Only a completely refreshed priority cohort reaches selection. The 25 are the best according to Score **within that refreshed cohort**;
  other accounts can have data up to 12 hours old. This is not a simultaneous global Top 25 claim.
  Cold start waits for adequate coverage. Missing trade evidence still fails the existing Score gates.

## Agent contract

The durable job contains schema version `1.0.0`, selection time and scope, the existing `toFrameCandidates` output, address mapping,
portfolio/fill timestamps, and at most 48 month PnL points per finalist. This uses Score's frame fields; it is not a completed formal committee input.
For each finalist the worker fetches positions from the same eligible DEX scope as the mirror (`""` and `"xyz"`), retains the largest 12,
and labels other DEXes uninspected. Models receive numeric candidate IDs and source kind, never source names or addresses.

Configure server-only `INGEST_AGENT_PROVIDER=openai|anthropic`, `INGEST_AGENT_MODEL`, and the matching `OPENAI_API_KEY` or `ANTHROPIC_API_KEY`.
Choose a model that supports the provider's JSON-schema output API. Missing configuration leaves the queue waiting.
One bounded batch request analyzes up to 25 sources. The result contains strategy hypotheses, confidence, evidence field references, risks and unknowns.
Strict validation requires exact candidate coverage and existing non-null evidence references; malformed/refused/truncated output fails the job.
Field-reference validation does not prove a model's interpretation is true. Persist input hash, bound anonymous evidence, provider/model and prompt version for inspection.
Successful jobs are not repeated; an expired running job has at most one recovery attempt. A provider success followed by a process crash can still cause a duplicate billable call.

The output has `economicAuthority: false`; finalists remain `picked: false`. This analysis cannot change frozen configuration, risk limits, weights or submit orders.
The existing Role/Risk/Red-Team committee and its OOS/execution-evidence requirements remain a separate boundary in [PRODUCTION_INTEGRATION.md](../agents/PRODUCTION_INTEGRATION.md).

## Rate limit, capacity and recovery

The shared Postgres limiter admits at most **1,200 Info weight per rolling minute**, the documented official REST limit per IP; the old 600 cap is removed.
The classification RPC lane uses a separate official 100/min cap.
Portfolio costs 20. Retries reserve again; `429 Retry-After` pauses other invocations too.
No recurring fill-history cost is included because there are no recurring fill-history requests.
See [official rate limits](https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/rate-limits-and-user-limits) and [fill pagination](https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/info-endpoint).
Four workers overlap network/SQL latency; they do not multiply the budget. Background requests wait while priority refresh is active.
Backend mirror/eligibility/paper reads also use the shared row. The executor's SDK and other processes sharing the public IP do not: stop the legacy collector at cutover and account for external traffic.

The 200 portfolio reads cost **4,000 weight per ten minutes**, before retries. Over 12 hours that is 288,000 of the theoretical 864,000 weight budget.
Fetching two DEX states for each of 25 finalists adds about 7,200 over that period. Roughly 568,800 remains for background evidence, mirror and other reads.
An offline replay of October 6 discovery produced 13,966 sources (13,862 traders, 104 vaults): refreshing those portfolios alone costs 279,320.
For portfolio alone, the remaining 576,000 weight can cover **28,800 further reads**, comfortably above that 13,966-source example.
There is therefore enough nominal portfolio capacity. The remaining headroom covers positions, retries and other reads; initial research is not repeated.
The production 12-hour target still requires observed throughput: network/SQL latency and scoring CPU are not established by rate-limit arithmetic.
The old discovery sample is not today's live universe.
Jobs report portfolio `updated`, `failed`, `elapsedMs`, `infoWeight`, `rpcRequests`, retries and rate-limit events; compare measured throughput and coverage before declaring the target achieved.

Postgres bucket claims prevent completed-run replay. Expiring account claims, retry backoff and atomic updates recover interrupted work.
Priority can preempt a waiting background account; the old token cannot overwrite the priority result. Classification persists even if history fetching fails.
Portfolio updates never leave partial fill evidence. Late discoveries/publications cannot replace newer epochs. Selection failure does not undo a successful priority refresh.
`waiting`/failed jobs may be retried; completed jobs are idempotent. Failed Agent requests need explicit operator inspection/requeue, not an unbounded paid retry loop.

## Deployment and verification

1. Retain current research/backups; stop the legacy SQLite/archive writer before enabling new crons.
2. Verify `DATABASE_URL` (server Postgres connection) and `CRON_SECRET` in the existing Vercel backend, plus optional model configuration. Do not paste secret values into tickets.
3. Back up the database, then apply `supabase/migrations/20261007110000_ingest_pipeline.sql` using the migration-owner connection.
   The migration moves the four legacy ingest tables into `ingest_legacy`, preserving rows and foreign keys, then imports their latest completed portfolios with original timestamps.
   Legacy data does not count as freshly collected. Do not re-run the old archive migration afterward.
4. Deploy `vercel.json` and the backend. Ingest can run without mirror configuration; mirror routes still require the existing frozen configuration and hash.
5. Run authenticated discovery, import the existing initial cache using the command below, then run background refresh. At ≥95% valid coverage, run priority; check its nested selection outcome.
6. Confirm `score_runs`, `ingest_agent_jobs`, and `GET /api/backend/artifacts/funnel` agree on the bucket and identities. Check both pool counts.
7. Run a real configured provider batch and inspect its evidence/analysis. Observe rolling coverage/throughput before marking the 12-hour and ten-minute targets verified.

### Reuse the existing screening cache (no source API calls)

From `packages/backend`, validate the preserved local SQLite database first:

```sh
bun --no-env-file src/ingest/import-screening.ts --source /absolute/path/to/loop.sqlite --check-only
# Once DATABASE_URL is provided privately and the migration is applied:
bun --no-env-file src/ingest/import-screening.ts --source /absolute/path/to/loop.sqlite --apply
```

The operator-only command opens SQLite read-only, checks blob hashes and identities, and imports initial order-count evidence and portfolio cache into Postgres.
It never imports running leases or old rankings and never calls Hyperliquid. Original timestamps remain intact; stale/invalid portfolios still require refresh.
Existing newer portfolios and existing baseline fill evidence win on retries. Imported-only addresses remain inactive until official discovery includes them.
The source database and raw trade blobs remain local and unchanged. SQLite is not a production runtime dependency.

```sql
select job, bucket, status, finished_at, summary
from public.ingest_runs order by started_at desc limit 12;
select generated_at, coverage from public.score_runs order by generated_at desc limit 2;
select bucket, state, attempts from public.ingest_agent_jobs order by bucket desc limit 4;
select classification->>'kind' as kind, count(*) as active,
       count(*) filter(where refreshed_at >= now()-interval '12 hours') as portfolio_12h,
       count(*) filter(where evidence_refreshed_at is not null) as initial_evidence_cached,
       max(now()-refreshed_at) as oldest
from public.ingest_accounts
where last_seen=(select max(last_seen) from public.ingest_accounts)
group by classification->>'kind';
```

These age queries diagnose collection; the loader additionally validates content and source endpoint timestamps.
If cutover fails, stop new crons and inspect before restoring service. Reverting code alone does not restore the old public table layout; archived data remains in `ingest_legacy`.

Tables: `ingest_accounts`, `ingest_portfolios`, `ingest_fill_stats`, `ingest_runs`, `ingest_budget`, `score_runs`, `ingest_agent_jobs`, existing `dashboard_artifacts`.
No API keys, private account snapshots or raw production logs are checked in.

## Test evidence and current limits

Backend tests use PGlite and controlled HTTP data for discovery → evidence → a mixed 200-source refresh → real teammate Score → 25-source Agent queue → structured mock analysis.
They cover both vault and trader participation, budget contention, preemption, no recurring fill requests, age gates, duplicate triggers and preservation of legacy tables.
`TEST_DATABASE_URL` additionally exercises Bun SQL through independent PostgreSQL connections in an isolated schema; service CI provides PostgreSQL 16.
Run `bun test` and `bun run typecheck` in `packages/backend`; root `pnpm typecheck && pnpm test` verifies review compatibility.

Local tests are not cloud deployment or a paid provider run. At preparation time the Vercel console required login, `DATABASE_URL` presence could not be confirmed,
and no cloud migration, new-cron cutover, real model analysis or production 12-hour coverage had been verified.

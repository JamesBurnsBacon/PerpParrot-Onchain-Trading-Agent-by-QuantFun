# Merging the review core with the CRE mirror path

On 2026-10-06 the branches `ai-agent-workflow` (review core and a parallel paper mirror) and
`cre-scaffold` (CRE mirror path, executor, snapshot service) were merged into `main`. Where both
had an approach to the same thing, the better one was kept. This records each choice and why.

## Kept from each side

| Area | Kept | From | Why |
|---|---|---|---|
| Review core, committee, schemas, prompts, evidence binding | `packages/cre-workflows/review/workflow.ts`, `packages/shared/src`, `packages/shared/schemas`, `review-spike`, `docs/agents` | review core | The AI workstream's domain; nothing on the mirror side overlapped |
| Review in CRE | `review-spike` (every node calls the model, per-field median consensus) | review core | The committee needs one observation per DON node. The mirror side's Confidential HTTP spike makes a single enclave call, which can't provide that |
| Frozen authority | `FrozenConfiguration` (`perpparrot:frozen:v1`), integer weight/ceiling/cash units | review core | Long-lived, unlike the expiring manifest. `packages/shared/frozen.ts` re-implements its checks without dependencies so they run in WASM; byte-identical commitments, checked against the review core's validator |
| Freeze confirmation | `configurationHash` pinned in mirror config, backend and executor | mirror path | Team decision: no onchain contract. Dropped: `FrozenMirrorConsumer.sol`, `chain-authority.ts`, `evm-rpc.ts` |
| Spot-check sampling | HMAC-SHA256 keyed by a CRE secret (`mirrorSamplingKey`) over run time and snapshot hash | review core (mirror spike) | Unpredictable to the backend. The mirror path's DON `Math.random()` seed is documented by Chainlink as not cryptographically secure |
| Spot-check content | positions **and** equity within 5%; renormalized weights must stay under frozen ceilings | review core (paper mirror) | Already adopted into the mirror path before the merge |
| CRE mirror workflow | `packages/cre-workflows/mirror` | mirror path | Runs end to end in `cre workflow simulate` against live HL data (six scenarios, soak, 25-source scale test). The review core's `mirror-spike` was paper-only and couldn't deliver reports |
| Snapshot producer | `packages/backend` (immutable per-run snapshots built at `:x9`, served to every node) | mirror path | Supersedes `backend/src/snapshot.ts` + `info-client.ts` from the review core, which read only core-dex `accountValue` (see Equity) and pushed the whole snapshot through consensus (23 KB budget) |
| Equity | HL `portfolio` account value | mirror path | The review core's adapter used core-dex `accountValue` and rejected unified/portfolio-margin accounts and HIP-3. Most leaderboard traders use unified or portfolio-margin accounts, and per-dex `accountValue` understates their equity 2–10× |
| Consensus on live reads | identical on snapshot-derived values, **median** on the spot-check deviation | mirror path | The review core's mirror spike required identical account states across nodes, which it noted would HOLD whenever node reads straddle an exchange update |
| Report and execution | DON-signed exposures report → executor (below) | mirror path | See "Report shape" |
| Executor | `packages/executor` | mirror path | Dropped the review core's preview lane: `compiler.ts`, `recovery.ts`, `paper.ts`, `supabase-store.ts` (standard accounts, core dex only; never submitted) |
| Durable state | `supabase/migrations/20261006120000_cre_mirror.sql` + `20261006130000_review_audit.sql` | both | The review core's `review_audit` table and `persist_review_audit` RPC were kept; its preview/nonce/alert-outbox tables belonged to the dropped preview lane |
| Alerts, health | executor watchdog + Telegram | mirror path | The review core's outbox needed a scheduler that didn't exist yet |
| Live bucket | **Aggressive** | README | Team decision 2026-10-06. The review core enforced Balanced-only live in three places; all now enforce Aggressive-only |
| Tooling | both: pnpm + Node 24 for the review core (root `package.json`, `tests/`), Bun per package for the mirror path | both | `pnpm-workspace.yaml` covers only `packages/cre-workflows`, and the root `tsconfig.json` covers only the review core, so neither toolchain trips over the other. CI: `agent-review-checks.yaml` and `cre-checks.yml` |

## Report shape: exposures, not orders

The review core's `rebalance-report.schema.json` puts up to 10 **orders** in the DON-signed report
(asset ID, side, limit price, size, client ID). The mirror path signs **exposures**: for each asset,
the target position as a fraction of our equity. The executor turns those into orders when it runs.

Exposures were kept, for five reasons:

1. **Consensus.** Every DON node runs the workflow independently and the report needs consensus.
   Exposures come only from the snapshot every node received byte for byte, so every node computes
   exactly the same numbers. Orders also depend on live mark prices, our live equity and our live
   positions, which each node reads at a slightly different moment. Identical consensus on those
   fails whenever reads straddle a price tick or a fill, and median consensus on prices or sizes
   can produce an order no node actually computed.
2. **Staleness.** A report is signed at `:x0` and executed seconds later; prices and our account
   move in between. With exposures, the executor sizes and prices orders against the account and
   mark at the moment it trades ("account = truth", README §4.4). Orders frozen into the report would
   trade at stale sizes and limits, and could double up if an earlier order filled after the read.
3. **HTTP budget.** Orders in the report would need the mirror to read market metadata and our
   positions on every DEX inside CRE's 15 HTTP calls per run. The mirror already uses 14; the
   executor makes those reads outside CRE, with no limit.
4. **Verifiability is the same.** Exposures are exactly what the copy model says to hold
   (`Σ wᵢ · nᵢ,c / Eᵢ`), so anyone can recompute them from the stored snapshot
   (`packages/executor/scripts/verify-run.ts`). The executor's plan, orders and fills are logged
   per run next to the signed report.
5. **Safety checks live in one place.** The $10 minimum (at the limit price), drift rule, 95%
   margin rule, reduce-only, the executor's own eligibility check and lot/tick rounding all need the
   live account, so they belong in the executor either way.

The trade-off: the DON doesn't attest to the exact orders, only to the target. The executor is
trusted to translate faithfully, which it would have to be anyway since it holds the trading key.
Its run log publishes every plan beside the report it came from.

## For the AI workstream after the merge

- Rebase onto `main`. `ai-agent-workflow`'s mirror-lane files were removed in the merge
  (listed above); its review-core files are unchanged except for the Aggressive-live rule.
- The review's output feeds the mirror through `proposeFreeze` → `packages/backend/scripts/freeze.ts`.
- Add new review checks to `tests/` (Node) and `agent-review-checks.yaml`.

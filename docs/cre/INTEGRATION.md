# Integrating `cre-scaffold` with the review core (`ai-agent-workflow`)

Both branches touch the mirror path. This note maps what each has, where they agree, and what to
decide before merging. Written 2026-10-06 against `ai-agent-workflow` at `8160323`, updated for `f168b0d`.

## Shared contracts (already compatible)

| Contract | Review core | `cre-scaffold` | Status |
|---|---|---|---|
| Commitment | `shared/src/commitments.ts`: keccak256(JCS({domain, payload})) | `packages/shared/commitments.ts` (dependency-free, runs in WASM) | Byte-identical; checked against the review core's code |
| Frozen authority | `shared/src/frozen.ts` `FrozenConfiguration`, `perpparrot:frozen:v1` | `packages/shared/frozen.ts` `checkFrozenConfiguration` | Same shape and checks except the Ajv policy schema (not available in WASM). The fixture passes `validateFrozenConfiguration` |
| Weights | integer `weightUnits`, `ceilingUnits`, `cashUnits` (1e6) | same units in bigint copy math | Same |
| Renormalization | invested budget kept; fail past a ceiling | same (`checkActiveCeilings`) | Same |
| Spot-check | Σ\|Δnotional\| and \|Δequity\| ≤ 5% of live equity | same (`deviationBps`) | Same |
| Drift / min order | ≥ $10 and ≥ 10% of target; zero target = close | same (executor planner) | Same |

## Different choices to settle

1. **Freeze confirmation.** The review core expects a `ConfirmedFreeze` from a chain adapter
   (a HyperEVM consumer). We dropped onchain contracts (2026-10-06): the `configurationHash` is
   pinned in the deployed mirror config and checked by the backend, the mirror and the executor.
   *Proposal:* treat the pinned hash as the confirmation and drop the chain adapter gate.
2. **Report shape.** The review core's `rebalance-report.schema.json` carries ≤ 10 **orders**
   (asset ID, side, limit price, size, cloid). `cre-scaffold` reports **exposures** (fractions of
   our equity) and the executor builds targets and orders against the live account. *Proposal:*
   exposures. Orders in the report need DON consensus on live prices, our equity and our live
   positions, which differ per node; exposures are deterministic from an immutable snapshot.
3. **Spot-check sample size.** The review core samples `min(10, sources)`. Each HL account needs
   3 calls (core + `xyz` positions, `portfolio` equity), so 10 sources would be 30 calls, over
   CRE's 15. `cre-scaffold` samples 4 (1 snapshot + 12 + 1 executor = 14).
4. **Equity.** Read from HL's `portfolio` request (live account value), not Σ per-dex
   `accountValue`, which understates equity for unified and portfolio-margin accounts (most
   leaderboard traders). Worth using the same definition in the review core's evidence.
5. **Snapshot commitment.** The review core hashes positions snapshots under
   `perpparrot:positions:v1`; `cre-scaffold` uses keccak256 of the served JSON bytes (nodes agree
   on bytes, not on a re-serialization). Either works; pick one before the dashboard verifies them.
6. **Tooling.** Review core: pnpm workspace, Node 24 test runner, root `tsconfig.json` with
   `NodeNext`. `cre-scaffold`: per-package Bun (`bun test`, `bun.lock`). The root `tsconfig.json`
   includes `packages/**/*.ts`, which would also typecheck `cre-scaffold`'s extensionless imports.
   *Proposal:* exclude `packages/{backend,executor,cre-workflows/mirror,cre-workflows/review}` from
   the root tsconfig, or move them into the workspace with `moduleResolution: "bundler"`.
7. **File collisions.** Both branches add `packages/executor/package.json` and files under
   `packages/cre-workflows/mirror/`. The review core's `paper.ts`, `core.ts` and `runner.ts` don't
   collide by name with `cre-scaffold`'s files, but the two `package.json` files do.

8. **Two CRE projects.** The review core has a root `project.yaml` (target `simulation-settings`,
   no RPCs) for `packages/cre-workflows/review-spike`; `cre-scaffold` has
   `packages/cre-workflows/project.yaml` (targets `staging-settings` / `production-settings`,
   private registry, deploy CI) for `mirror` and `review`. The CLI finds the nearest
   `project.yaml`, so both work after a merge, but deploys go through
   `packages/cre-workflows`. *Proposal:* move `review-spike` under that project and add its
   targets there.

9. **New since `f168b0d` (2026-10-06 15:44).** The review core now also adds:
   - `packages/backend/src/snapshot.ts` (`produceSnapshot`, its own snapshot shape and
     `perpparrot:positions:v1` hash): **same path as `cre-scaffold`'s snapshot builder**, a
     certain merge conflict, and a second snapshot format for the same `:x9` job.
   - `packages/backend/migrations/001_execution_state.sql` (`preview_*`, `mirror_health`,
     `alert_outbox`, `review_audit`): a second schema next to `supabase/migrations/`, which is
     the directory the Supabase project is linked to.
   - `packages/contracts/src/FrozenMirrorConsumer.sol`: a HyperEVM freeze consumer, which the
     2026-10-06 decision to drop onchain contracts (item 1) rules out.
   - `packages/cre-workflows/mirror-spike`: a second mirror workflow.
   *Proposal:* one snapshot builder, one schema directory (`supabase/migrations/`), one mirror
   workflow; keep `review_audit` (the review core's own table) and drop the contract.

## Review core gates that `cre-scaffold` implements

From `docs/agents/PAPER_INTEGRATION.md` "Required production adapters and gates":

| Gate | `cre-scaffold` |
|---|---|
| 2. Backend snapshot producer, independently queried account states, agreed entropy | `packages/backend` (immutable per-run snapshot at `:x9`); mirror reads accounts directly from HL in node mode; sample seeded by the snapshot ID, identical on every node |
| 3. CRE SDK mirror wrapper | `packages/cre-workflows/mirror/main.ts`: `runInNodeMode` + per-field consensus, `report()`, `sendReport()`; passes `cre workflow simulate` against live HL data |
| 4. Live report compiler: asset IDs, lot/tick rounding, slippage, margin | executor `src/planner.ts`, `src/hyperliquid.ts` (HIP-3 IDs `100000 + dex × 10000 + i`), `@nktkas/hyperliquid` formatting, 95% margin rule, reductions before increases |
| 5. Durable claim/ledger, nonce ownership, partial fills, restart recovery, report provenance | Postgres `executor_reports` (claim), `executor_runs` (plans, results, raw signed reports); single executor process owns nonces; per-order statuses kept on partial failures; DON signatures verified against the Capability Registry. Exchange reconciliation = next run diffs against the live account |
| 6. Failure state, watchdog, alerts | missed-report watchdog + Telegram alerts in the executor |

Not covered by `cre-scaffold`: gate 1 (chain freeze adapter, proposed to drop) and gate 7 (review
evidence bridge, model evaluation).

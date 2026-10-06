# Integrating `cre-scaffold` with the review core (`ai-agent-workflow`)

Both branches touch the mirror path. This note maps what each has, where they agree, and what to
decide before merging. Written 2026-10-06 against `ai-agent-workflow` at `8160323`.

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
   (asset ID, side, limit price, size, cloid). `cre-scaffold` reports **targets** and the executor
   builds orders against the live account. *Proposal:* targets. Orders in the report need DON
   consensus on live prices and our live positions, which differ per node; targets only need
   consensus on deterministic exposures from an immutable snapshot plus a median equity.
3. **Spot-check sample size.** The review core samples `min(10, sources)`. Each HL account needs
   2 calls (core + `xyz` dex), so 10 sources + our account + snapshot + executor = 24 calls,
   over CRE's 15. `cre-scaffold` samples 5 (14 calls).
4. **Snapshot commitment.** The review core hashes positions snapshots under
   `perpparrot:positions:v1`; `cre-scaffold` uses keccak256 of the served JSON bytes (nodes agree
   on bytes, not on a re-serialization). Either works; pick one before the dashboard verifies them.
5. **Tooling.** Review core: pnpm workspace, Node 24 test runner, root `tsconfig.json` with
   `NodeNext`. `cre-scaffold`: per-package Bun (`bun test`, `bun.lock`). The root `tsconfig.json`
   includes `packages/**/*.ts`, which would also typecheck `cre-scaffold`'s extensionless imports.
   *Proposal:* exclude `packages/{backend,executor,cre-workflows/mirror,cre-workflows/review}` from
   the root tsconfig, or move them into the workspace with `moduleResolution: "bundler"`.
6. **File collisions.** Both branches add `packages/executor/package.json` and files under
   `packages/cre-workflows/mirror/`. The review core's `paper.ts`, `core.ts` and `runner.ts` don't
   collide by name with `cre-scaffold`'s files, but the two `package.json` files do.

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

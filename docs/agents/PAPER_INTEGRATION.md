# Paper integration status

Run `pnpm paper:smoke` for a synthetic snapshot → independent account checks →
mirror plan → shared paper report → independently rebuilt paper receipt → replay.
No network, signing key, real orders, or exchange fills are used by this command.

## Ownership

- `packages/cre-workflows/mirror/runner.ts`: local orchestration with bounded
  deadlines, agreed source sampling, separate freeze/snapshot/account adapters,
  cancellation, and HOLD on any fetch failure. At most one snapshot plus eleven
  direct account fetches. Freeze verification is a separate chain capability.
- `packages/shared/src/mirror-plan.ts` and `paper-report.ts`: canonical plan and
  strict paper envelope, binding chain, account, configuration, evidence, run,
  expiry and hashes. This envelope is deliberately not the live report schema.
- `packages/executor/src/paper.ts`: local synchronous paper consumer, independent
  evidence rebuilding, same-run conflict rejection and isolated cached receipts.
  Its ledger is in memory and does not survive process restart.

## Exposure checks

The planner checks desired targets, holdings remaining after drift gates, and
independent partial-fill endpoint maxima. The last bound conservatively rejects
runs whose buy-before-sell ordering could exceed the gross cap. It can also HOLD
an already over-cap account; emergency reduction requires a separate approved
policy. It does not model mark-price movement, fees, maintenance margin, DEX
collateral pools or leverage configuration. It is not a liquidation proof.

## Required production adapters and gates

1. Authenticated chain confirmation of frozen configuration; an arbitrary
   `ConfirmedFreeze` object is not chain proof.
2. Backend snapshot producer and independently queried master-account states,
   consistent market identifiers and valuation times, plus trusted agreed entropy.
3. A CRE SDK mirror wrapper. The local runner uses JavaScript timers and promises;
   do not compile it as a CRE handler without adapting to SDK capabilities.
4. Versioned live report compiler with exchange asset IDs, exact lot/tick rounding,
   prices, slippage, account margin/DEX checks and explicit reversal sequencing.
5. Durable execution claim/ledger, exchange reconciliation, nonce ownership,
   partial fills, restart recovery and authenticated report provenance.
6. Durable consecutive-failure state, watchdog and alert outbox.
7. Full review evidence bridge, two-model point-in-time evaluation, audit storage,
   configured CRE/model secrets and actual authenticated simulation.

Paper full-fill receipts are deterministic arithmetic examples, not performance
backtests. No live execution gate is relaxed by these additions.

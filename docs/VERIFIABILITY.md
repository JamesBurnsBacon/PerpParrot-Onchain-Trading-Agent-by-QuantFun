# What you can check yourself

> **Status: a proposal for discussion, not an agreed document.**
> The most important question is not the wording below. It is whether the team (James in particular) actually feels this gap
> and sees value in this angle: that anyone can check what the system did, instead of trusting the backtest and our claims.
> If the answer is "no" or "not now", this PR should simply be closed. Everything here (the framing, the wording guide, the
> README lines and the demo idea) is a suggestion that only applies if the team agrees it is worth it.

## Questions for the team first

1. Do you feel the README leaves a gap here? Today it presents the backtest as the main value claim (§4.9) and mentions
   verification only in passing (TL;DR, §4.11).
2. Do you see value in presenting "checkable" as a second pillar next to the backtest, for the Chainlink track, the judges or
   anyone who might follow the strategy? Or is the backtest enough?
3. If yes: is the scope below right (committed set, signed reports, recorded plans), and are the limits stated honestly enough?
4. If no: close this PR. Nothing else depends on it.

## The idea

Do not take our word for it: check the committed configuration, the signed target exposures and the recorded execution plan.

Why this matters after deployment and the production freeze:

- The live record is evidence: the source wallets and rules are committed by hash before trading, so a later swap of wallets or rules would show up as a different hash.
- A difference is detectable: the executor trades on DON-signed reports (the manual Pause and Flatten controls are the exception), and anyone can recompute the target from the stored snapshot and compare it with the recorded plan. A run that was never logged is not covered; see Limits.
- The AI is recorded and bounded by checks, so its decisions are not trusted blindly.

These checks do not prove profit, strategy quality or AI correctness, and the DON does not attest to the exact orders.

## Four questions a sceptic asks

### 1. Did you pick the wallets after seeing the results?

- **In plain words:** The freeze commits to the wallet choices and rules before trading starts.
- **What is recorded:** A configuration hash binds the sources, weights, limits, cash allocation, account and policy.
- **How to check:** Follow the [Freeze procedure](cre/RUNBOOK.md#freeze-go-live-set). The hash is part of the deployed workflow ID and each DON-signed report; the executor rejects a different hash.
- **What you still have to trust:** The production freeze is still pending. There is no onchain contract.

### 2. Did the operator trade something other than what was reported?

- **In plain words:** Compare the signed target with the plan and order results.
- **What is recorded:** The run log (`GET /runs`) stores plans, order results and raw signed reports.
- **How to check:** Run `verify-run`, then compare the report with the plan and results. A dashboard signature count is not verification.
- **What you still have to trust:** The executor translates targets into orders and holds a trading key that cannot withdraw. A human holds the master key.

### 3. Is the data behind a rebalance real and the same for everyone?

- **In plain words:** Every DON node gets the same snapshot. Four sources are re-read from Hyperliquid to spot-check it.
- **What is recorded:** The report records the snapshot ID, hash, account and target exposures.
- **How to check:** Use `verify-run --backend` to check the snapshot hash. Recompute exposures with [`packages/shared/copy.ts`](../packages/shared/copy.ts).
- **What you still have to trust:** The spot-check samples four sources, not all of them. Its sampling secret is hidden from the snapshot service.

### 4. Can the AI be trusted?

- **In plain words:** The AI is recorded and bounded, not proven correct. An invalid bucket cannot authorise trades.
- **What is recorded:** `review_audit` stores bound prompts, evidence, validated committee outputs, their hashes and the model version.
- **How to check:** Read the [review boundaries](agents/ARCHITECTURE.md#cre-and-signing-boundaries) and audit code in Sources. The audit records are private and service-role only.
- **What you still have to trust:** Using the same model across DON nodes does not remove shared bias or give independent investment opinions. After go-live, review is commentary only and cannot replace the frozen manifest.

## Check a run yourself

1. Find a run in the dashboard run log and download its signed report for inspection.
   The signature count is not a verification result; checking is done with `verify-run`.
2. Use the commands below from the [runbook](cre/RUNBOOK.md), with the executor URL for the run you want to inspect.
   For registry checks, `verify-run` reads the Ethereum Capability Registry through the RPC URL in the environment variable `ETH_MAINNET_RPC_URL` ([script](../packages/executor/scripts/verify-run.ts)).
   The `https://…` values are placeholders; `[--run mirror-…]` denotes an optional run selector, not literal shell syntax.

   ```sh
   cd packages/executor
   bun run scripts/verify-run.ts --executor https://… [--run mirror-…]
   ```

3. Include `--backend` to check the stored snapshot as well:

   ```sh
   bun run scripts/verify-run.ts --executor https://… --backend https://… [--run mirror-…]
   ```

4. For runs from `cre workflow simulate`, add `--simulation` to either command.
   Simulation uses local test keys that are not registry signers, so in this mode the signature check only confirms that signatures can be recovered.
   CRE deploy access is not yet approved, so the existing runs are simulations.

The script checks a run independently of the executor.
Its printed checks mean:

| Printed check | Meaning |
|---|---|
| `≥ f+1 DON signatures from the Capability Registry, pinned workflow owner` | Enough signatures match the Capability Registry on Ethereum mainnet, and the report has the pinned workflow owner. |
| `signatures recover` | Signatures can be recovered; see step 4 for the scope of this check. |
| `report ID = keccak256(report)` | The stored report ID matches the hash of the report bytes. |
| `snapshot hash matches the stored snapshot` | With `--backend`, the stored snapshot hashes to the report's `snapshotHash`. |

For the by-hand version, see “Re-verifying a run's report” in [the runbook](cre/RUNBOOK.md).

## Why a tampered report fails

The signature covers the report bytes and their context: `signedHash(rawReport, context)` in [`verify.ts`](../packages/executor/src/verify.ts).
The workflow owner, workflow name and DON come from the signed report header.

The negative tests in [`packages/executor/test/verify.test.ts`](../packages/executor/test/verify.test.ts) are evidence that the checks reject bad input.
They cover too few registry signatures, unknown signers, counting a signer twice, a different workflow owner, a tampered body, malformed hex, mismatched pinned workflow name or DON, expired reports, reports from the future, excessive lifetime, a different frozen configuration and another account.

## Limits

- CRE runs are simulated only while deploy access awaits approval; their local test keys are not registry signers.
- Flatten (and Pause) are manual admin actions behind a bearer token; Flatten closes every position reduce-only and bypasses CRE, so those closes are not DON-signed ([README §4.8](../README.md)).
- The DON attests to target exposures, not exact orders; the executor is trusted to translate them and publishes each plan beside its report.
- Same-model aggregation does not supply independent investment opinions or remove shared bias; deterministic validation still has to pass.
- A failed snapshot, consensus, spot-check or executor rejection fails the run and leaves positions held; there is no backend fallback.
- The executor alerts on Telegram after 25 minutes without a report.
- CRE API key access or repo write access can deploy a workflow whose reports the executor trusts.
- A human holds the master key; trades made with it are outside these checks.
- The team hosts the run log; it is not onchain, and a missing report is noticed through an alert, not enforced by a contract.
- Each spot-check covers four sources, not all sources.
- The capital is the team's own; managing other people's money is a non-goal.

## Status today

| Item | Status | Where to read the current state |
|---|---|---|
| Signature checks, executor intake rules and `verify-run` | Built; unit tests cover signature rejection and intake rules. `verify-run` provides independent report checking. | [README status and §4.8](../README.md), [verification tests](../packages/executor/test/verify.test.ts), [verification script](../packages/executor/scripts/verify-run.ts) |
| CRE runs | Simulated only; deploy access is not yet approved. | [README status and §4.14](../README.md), [runbook](cre/RUNBOOK.md) |
| Production freeze | Not fixed yet; the commitment is built and tested. The production config still has an all-zero hash and `REPLACE` URLs, which the deploy config check refuses. | [Production config](../packages/cre-workflows/mirror/config.production.json), [Freeze procedure](cre/RUNBOOK.md#freeze-go-live-set), [config check](../packages/cre-workflows/scripts/check-config.ts), [deploy workflow](../.github/workflows/cre-deploy.yml) |
| Review audit trail | Private; `review_audit` is service-role only. | [Audit storage](../packages/backend/review/audit.ts), [audit migration](../supabase/migrations/20261006130000_review_audit.sql) |

## How to talk about it

- Do use “committed before go-live” for the freeze procedure; say that the production freeze is still pending.
- Do say “anyone can recompute the target from the stored snapshot”; the target means exposures, not exact orders.
- Do say “any change to the report or its context is detected” when describing registry signature verification. This does not apply to simulation signatures; see Limits.
- Do not claim that all trust is removed, AI judgments are correct, or returns are assured.
- Video sentence now, in simulation: “This run is simulated; we can check its report ID and stored snapshot hash, but its signatures are from local test keys.”
- Video sentence only valid after CRE deploy access and the production freeze: “Each CRE rebalance is signed by the DON; anyone can check the signatures against the Capability Registry and recompute the target from the stored snapshot.”
- Suggested README sentence: “Check the signed target exposures against the stored snapshot, then inspect the executor's published plan.”
- If the team wants this in the README (not done in this PR): one TL;DR bullet after the bullet that begins "Every 10 minutes, Chainlink CRE verifies", but only once the production freeze and CRE deploy are done (until then say that the freeze is pending), for example `**Checkable by anyone:** the source set is committed by hash before go-live, and each CRE rebalance report is DON-signed and can be recomputed from stored data; see "what you can check yourself" (docs/VERIFIABILITY.md).`, and one link to this file in the "Where things are" line.

## A demo idea (proposal, not yet run live)

After CRE deploy access and the production freeze, show a run's report passing a registry check with `verify-run`, then change one number and show verification fail.
This demo has not been run live; tampered-report rejection is covered today only by the unit tests above.
See Limits for the scope of current runs.

## Sources

- [`README.md`](../README.md): §§1, 4.7, 4.8, 4.11, 4.14 and 7, plus the status line.
- [`docs/cre/INTEGRATION.md`](cre/INTEGRATION.md): report shape and the execution trade-off.
- [`docs/cre/RUNBOOK.md`](cre/RUNBOOK.md): freeze and re-verification procedures.
- [`docs/agents/ARCHITECTURE.md`](agents/ARCHITECTURE.md): validation and CRE signing boundaries.
- [`packages/shared/copy.ts`](../packages/shared/copy.ts): exposure arithmetic.
- [`packages/cre-workflows/mirror/config.production.json`](../packages/cre-workflows/mirror/config.production.json): production freeze state.
- [`packages/cre-workflows/scripts/check-config.ts`](../packages/cre-workflows/scripts/check-config.ts) and [`.github/workflows/cre-deploy.yml`](../.github/workflows/cre-deploy.yml): deployment gate.
- [`packages/executor/src/verify.ts`](../packages/executor/src/verify.ts) and [`packages/executor/test/verify.test.ts`](../packages/executor/test/verify.test.ts): signature checks and negative tests.
- [`packages/executor/scripts/verify-run.ts`](../packages/executor/scripts/verify-run.ts): independent run checks.
- [`packages/dashboard/components/RunLog.tsx`](../packages/dashboard/components/RunLog.tsx): signature count and report download.
- [`packages/backend/review/audit.ts`](../packages/backend/review/audit.ts) and [`supabase/migrations/20261006130000_review_audit.sql`](../supabase/migrations/20261006130000_review_audit.sql): private review records.

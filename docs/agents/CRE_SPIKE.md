# CRE review spike and mirror integration boundary

## Implemented and verified scope

The simulation-only `packages/cre-workflows/review-spike` calls the OpenAI Chat
Completions endpoint through the actual CRE HTTP capability. It requests strict
structured JSON, validates every candidate row inside node mode, flattens numeric
fields in stable candidate order, and uses the SDK's per-field median descriptor.
It rejects provider refusals, incomplete responses, extra economic fields,
candidate mismatches and invalid scores. Post-consensus validation runs again.
There is no cache, score fallback, report generation, chain write or order endpoint.

The example model is pinned to `gpt-4.1-mini-2025-04-14` for the spike. It is not a
backtest winner or a production endorsement. Model latency, availability and
selection quality need measurement with the actual account and dataset.

Strict Zod input/output contracts live in `packages/shared/src/review-wire.ts`.
Inputs include 26–48 irregularly timed PnL-curve points, current signed positions,
leverage and liquidation distance, holding time, time in market, maker share,
trade-pattern indicators and a complete pair matrix. Unknown names, descriptions,
addresses and instruction fields are rejected. Null values preserve uncertainty.
Each finalist is limited to 4,096 UTF-8 JSON bytes. The full base64 HTTP request
envelope has a conservative 115,000-byte bound; consensus scores are bounded to
20,000 JSON bytes, reserving headroom below CRE's 25 KB observation quota.
These checks supplement, rather than replace, quota-enforced simulation.

The supplied two-finalist input is synthetic: one slow-holding and one short-holding
source. This proves API wiring only. It is intentionally not sufficient to freeze
a 5–25-source real-money selection. No actual historic profitability is represented.

## Reproducible commands

Requires Node 24+, pnpm and Bun. Verification used CRE SDK 1.23.0, CRE CLI 1.37.0
and Bun 1.4.2. The SDK is pinned and its transitive dependencies are lockfile-backed.
Type checking uses Bundler resolution because the SDK's declaration exports use
extensionless imports. Node executes the offline tests directly; no JS is emitted.

From the repository root:

```sh
pnpm install --frozen-lockfile
pnpm test
pnpm typecheck
pnpm test:cre
pnpm compile:review-spike
```

The SDK's own runtime test harness covers the HTTP request, `main` secret namespace,
numeric median descriptors, missing credentials and redacted HTTP failures. That
harness executes one observation; it is not evidence of real multi-node consensus.

The GitHub checks workflow repeats the offline tests, SDK harness, schema checks,
type check and WASM compilation on pushes to `ai-agent-workflow` and pull requests.
Actions are pinned to verified commit hashes; it has read-only repository permissions,
no model/execution secrets, and no simulation, deployment or broadcast step.

Install the official CRE CLI using the documented installation process. Authenticate
with `cre login`. Set `OPENAI_API_KEY` in an ignored root `.env` using your own secure
editor; do not put keys in config JSON, Git, prompts, screenshots or command arguments.
`secrets.yaml` contains only the environment-variable mapping. For deployment, upload
secrets to the Vault DON as described in the current official guide; local simulation
and deployed secret provisioning are separate.

```sh
cre --non-interactive --target simulation-settings workflow simulate \
  packages/cre-workflows/review-spike \
  --wasm work/review-spike.wasm --limits default --trigger-index 0
```

Do not add `--broadcast`. This spike has no EVM writes regardless. The cron is hourly;
running the command explicitly invokes the first configured trigger for simulation.
The provider request has a 10-second timeout matching the documented default maximum.
A timeout is a failure; there is no retry storm or manufactured default score.

Recorded verification on 2026-10-06: actual WASM compilation succeeded without runtime
compatibility or nondeterminism warnings. The simulation command stopped at CRE
authentication (`not logged in`, no `CRE_API_KEY`). No real LLM call, production quota
execution, provider bill, deployed DON operation or mainnet transaction was verified.
Keep this distinction in release notes until a real simulation receipt exists.

## Frozen configuration and fresh state

`packages/shared/src/frozen.ts` separates the long-lived allocation commitment from
the short-lived review evidence. A freeze proposal must originate from a still-valid
LIVE review, contain 5–25 distinct sources, preserve Balanced-only live policy, and
quantize weights down to integer millionths. Rounding residual stays in cash. It does
not write a consumer or activate a portfolio. Self-copying the execution account is
rejected. After confirmation, original review expiry does not invalidate the frozen
configuration; every mirror snapshot and resulting plan retains its own expiry.

`ConfirmedFreeze` is a trusted adapter contract, not a signature verifier. Before any
live use, a chain adapter must read the correct consumer on the correct chain,
authenticate the configured CRE workflow identity, wait for required confirmation,
check the committed account/hash and active state, and handle pause/revocation.
Untrusted backend JSON must never be cast directly into this interface.

The original `requireFrozenLiveManifest` remains intact for compatibility with the
original expiring-manifest contract. Ongoing integration should use the new separated
configuration/state boundary. Neither helper establishes chain provenance by itself.

## Mirror calculation and operational primitives

`packages/cre-workflows/mirror/core.ts` is deliberately a PAPER-only deterministic
compiler. It has no CRE capability calls or executor connection. Its inputs require
complete frozen-source coverage, committed snapshots, fresh source/account readings,
fresh spot checks, agreed sample identities and market limits. USD values use bounded
canonical integer micro-USD strings and BigInt arithmetic. Slice division truncates
toward zero. Input data must use a common market namespace and valuation convention;
the integration must not compare notionals at incompatible prices or units.

The discrepancy test sums absolute per-market differences against 5% of directly
checked equity. Long/short errors cannot cancel. Material equity mismatch also rejects
the run. This remains sampling, not complete proof of snapshot honesty: unselected
sources may still be wrong. The directly fetched execution account is account truth.

Active-source normalization preserves the invested budget; it cannot exceed frozen
source ceilings. Ineligible source positions are skipped rather than reassigned.
Market and gross-exposure limits reject unsafe plans. Held markets need an explicit
close policy. Reduce-only markets cannot open, increase or reverse positions. All-flat
sources yield zero targets and eligible close deltas; no division by zero. Netted
differences must exceed both $10 and 10% of target, with a zero target treated as a
close. Small residuals remain actual account exposure, not imaginary completed fills.
The compiler does not yet prove intermediate execution margin, liquidation safety,
post-rounding exchange precision, slippage or risk from skipped drift legs. These are
live executor/assessment gates. Cross-direction deltas require executor handling;
the paper compiler does not submit a flip order.

The plan commitment binds the frozen configuration, snapshot, actual account,
sample/check/market-limit evidence, run identity and freshness. Its `PAPER` marker
cannot be used as a live `RebalanceReport`. No report signing or DON verification is
implemented here. `buildMirrorPlan` returns HOLD for invalid input and has no side effects.

`mirror/operations.ts` provides deterministic hash-ranked sampling from a shared,
trusted seed and a pure failure-state transition. Sampling does not generate entropy;
the real CRE orchestrator must establish the seed, never independent node-local
randomness or backend-controlled selection. Duplicate/out-of-order slots cannot
inflate failures or reset newer state. The second consecutive failure generates an
idempotency key, with no repeated alert during the same streak.

Persist the transition and alert-outbox record atomically with compare-and-swap or a
database transaction. Deliver alerts through an idempotent worker. A separate watchdog
must record missed trigger slots: a workflow that never completes cannot update its
own failure count. No durable database or Telegram adapter is fabricated in this code.

## Remaining gates for sections 4.6 and 4.7

- Complete the authenticated, quota-enforced real-model simulation; test malformed
  responses, rate limits and timeouts, then validate multi-node behavior on the DON.
- Build the rich-data producer and point-in-time model A/B evaluation with the actual
  10-minute delay, netting, fees, $10 floor and source-history limitations. Connect the
  rich evidence to Role/Risk/Red-Team adapters; this API spike is not that full pipeline.
- Store prompts, outputs and hashes in Supabase with immutable run/model/input identity,
  redacted authorization data and idempotent writes. Budget every HTTP call. Arbitrary
  provider IDs and prose must not participate in numeric consensus.
- Implement and verify the HyperEVM freeze consumer and chain read adapter. Resolve
  the README Aggressive-live versus contribution Balanced-live conflict explicitly.
  There is no automatic removal of the existing guard.
- Build the ten-minute CRE mirror capability wrapper, shared sampling seed, authenticated
  snapshot/market adapters and real position-replay assessment. Bound every request,
  response and freshness window. Nominal HTTP budget: snapshot + ten checks + own
  account + executor submission = thirteen; logging, alerts, retries and extra DEX reads
  must fit the remaining two calls or use separate workflows. EVM quotas are separate.
- Bind and verify actual DON-signed reports; persist report IDs, nonce/cloid state and
  receipts. Reconcile an uncertain exchange result before another submission. Prove
  zero model calls and zero source-set changes in the frozen mirror path.
- Run replay and a monitored paper soak with injected outages and restart tests. Funded
  activation remains a separate explicit decision after these gates pass.

## Research sources and how they were used

- [Chainlink YouTube bootcamp, Day 1](https://www.youtube.com/watch?v=pLAttM7-UTA)
  and [Day 2](https://www.youtube.com/watch?v=4uFkjHgucEE): official session descriptions
  identify the setup/simulation and AI HTTP/EVM composition lessons. The video stream
  and full transcript were not accessible through the research tools; no timestamped
  or transcript-derived claim is made.
- [Bootcamp companion code](https://github.com/smartcontractkit/cre-bootcamp-2026/blob/main/prediction-market/my-workflow/gemini.ts):
  inspected for capability composition. Its response-ID/raw-text identical consensus
  and older cache fields were not copied. The code is educational, not audited production
  trading infrastructure.
- [Official SDK source](https://github.com/smartcontractkit/cre-sdk-typescript) and
  the installed 1.23.0 declarations/compiler: authoritative APIs for this implementation.
- [HTTP client](https://docs.chain.link/cre/reference/sdk/http-client-ts),
  [service quotas](https://docs.chain.link/cre/service-quotas),
  [deployed secrets](https://docs.chain.link/cre/guides/workflow/secrets/using-secrets-deployed),
  [CLI installation](https://docs.chain.link/cre/getting-started/cli-installation/macos-linux)
  and [supported networks](https://docs.chain.link/cre/supported-networks-ts): current
  platform constraints. CLI/Bun release asset SHA-256 digests were verified before use.
- [OpenAI Structured Outputs](https://platform.openai.com/docs/guides/structured-outputs):
  provider schema mechanism; runtime parsing additionally handles refusal and truncation.

Tutorial success, local tests and median agreement do not establish model investment
quality or mainnet trading safety.

# Production integration status

These additions close implementation seams; they do not authorize real trades.
The user reported that CRE access, model secrets, and exchange-account setup are
still being arranged. No deployment, database migration, Telegram notification,
exchange submission, leverage update or capital transfer was performed.

## Implemented and locally exercised

| Component | Ownership and verified behavior |
| --- | --- |
| Anonymous rich review evidence | `shared/committee-evidence.ts` binds the summary frame, full curve/positions/patterns and matrix, rejects contradictions, and bounds the combined finalist at 4 KB. It does not turn the spike's scores into specialist judgments. `backend/src/audit.ts` persists bound prompt/evidence and strictly validated committee output through a service-only idempotent RPC. Real provider output has not been persisted yet. |
| Backend account/snapshot adapters | `backend/src/info-client.ts`, `snapshot.ts`: fixed read-only Hyperliquid endpoint, bounded responses, master-account queries, complete batches and a 23 KB snapshot consensus budget. Hosting and :x9 scheduling remain to be configured. |
| CRE paper mirror | `cre-workflows/mirror-spike`: actual SDK Cron/EVM/HTTP calls, HMAC sampling of the consensus-fixed snapshot and finalized block with a CRE-only sampling secret, immutable consumer/code identity checks, source and own-account checks, strict identical normalized consensus and HOLD on failure. 25-source harness uses 13 HTTP calls including independent consumer bytecode verification; report delivery would be the fourteenth. No caching, fallback, report delivery or chain writes. |
| Exact execution preview | `executor/src/compiler.ts`: decimal/BigInt lot and perp tick arithmetic, minimum size/notional, slippage, unique client IDs, quantity/valuation binding, rounding-aware gross/market caps and conservative margin/fee reserves. Reversals close reduce-only; reopening needs fresh evidence. |
| Freeze/report consumer | `contracts/src/FrozenMirrorConsumer.sol`: immutable forwarder/owner/workflow/account checks (forwarder must have code), production 64-byte metadata, one-time freeze, paused initial state, chain binding, bounded expiry and strictly advancing mirror slots. Compiled and exercised in a local EVM. |
| Chain authority adapter | `executor/src/chain-authority.ts`: pinned canonical block reads, bytecode hash and immutable deployment identity checks. Requires the actual verified deployment and a compatible EIP-1898 RPC. |
| Durable preview recovery | `backend/migrations/001_execution_state.sql`, `executor/src/supabase-store.ts`, `recovery.ts`: transactional account claims, persistent per-signer nonces, conflicting-replay rejection, ambiguous-send reconciliation and locks retained until terminal confirmation. PostgreSQL-compatible disk/restart tests exercise the actual SQL. No live venue implementation. |
| Health and alerts | The migration atomically creates an outbox entry after two failures. `backend/src/alerts.ts` leases and acknowledges confirmed Telegram sends; local fake-transport tests only. Telegram ambiguity can duplicate an alert ID; delivery is at least once. A scheduler must record missed slots as failures. |

## Deliberate execution boundaries

Execution previews support **standard accounts, core USDC cross-margin perps only**.
HIP-3, isolated, unified and portfolio accounts are rejected until collateral-pool
valuation, account ratios and execution semantics are implemented and verified.
The README's original Aggressive/95%-margin design is retained as historical design;
the contribution continues to require Balanced live and explicit reserve limits.
No preview can be submitted as a live report: its version is `2.0.0`, mode is
`PREVIEW`, and `economicAuthority` is false. The original v1 report schema is not
silently repurposed. The compiler's context is trusted adapter evidence, not model
output; actual market metadata/leverage/order-state adapters are still required.

The margin check is a conservative initial-margin and fee-reserve bound, not a
liquidation model. Mark movement, margin tiers, funding and stressed maintenance
requirements need account-specific tests. Unsupported or already unsafe states can
HOLD; this is not an automatic emergency flatten implementation.

## Contracts and configuration

`consumer.ts` ABI encodes exactly eight static words:
`(kind, chainId, account, configurationHash, payloadHash, slot, issuedMs, expiresMs)`.
Kind 1 freezes a valid reviewed configuration; kind 2 records an execution-report
hash. Review and mirror workflow IDs must differ. Administrator activation is
required after the freeze. The deployed workflow must generate and deliver these
reports using CRE's authenticated capability; the consumer is not a signer.
Consumer permissions cannot be disabled or rotated. New identity requires a new
verified deployment, which is deliberate for the frozen launch.

Production KeystoneForwarder metadata is 64 bytes, with owner at bytes 42–61.
The production consumer rejects mock/empty metadata. Use a separate local fixture
for simulations; do not weaken the production contract to accept MockForwarder.
Strict identical account-state consensus can HOLD when DON requests straddle exchange updates. Deployment tests must measure this and validate a consistent read/caching strategy; the harness is not evidence that live DON jitter is solved.

A consumer hash acceptance is not itself an exchange order: the executor must
verify the exact signed payload, deployment identity and accepted hash before any
live submission. Offchain DON signature verification remains unimplemented.

Generate `mirror-spike/config.simulation.json` only after deployment verification.
The schema in `mirror-spike/wire.ts` requires frozen configuration, snapshot URL,
SDK chain selector, read-only RPC URL, consumer/runtime bytecode hash, forwarder, owner, both workflow
IDs, market limits and freshness. No secret belongs in this JSON. Configure a random 32-byte `MIRROR_SAMPLING_KEY` through CRE secrets; it must be shared by the DON and kept from the snapshot producer. A public chain hash alone is predictable and is not sufficient for adversarial spot-check selection. Root RPC setup
and actual tenant support are still required. The config is intentionally absent
rather than filled with fictitious mainnet addresses.

Apply the SQL migration to a fresh staging Supabase project first. It exposes only
service-role RPCs, enables RLS and denies browser roles. `SupabaseRpc` accepts a
server-only service credential, never a CRE secret. The included preview tables
are a separate lane; do not connect live signing to their simulation coordinator.
PGlite verifies SQL semantics locally; it does not prove deployed PostgREST roles,
production parallel workers or operational backups. Test those in staging.

## Remaining gates before funded use

1. Complete actual Role/Risk/Red-Team model capability adapters and bind full rich
   evidence; post-freeze reviews must remain monitoring-only.
2. Run the two-model point-in-time evaluation, select the winner and persist the
   full sanitized prompt/output audit with verified hashes and paper shadow state.
3. Configure CRE/model secrets; run authenticated LLM and mirror simulations and
   verify deployed consensus, tenant chain support and request quotas.
4. Deploy and verify the consumer, generate the reviewed freeze report, and verify
   its confirmation before activation. No deployment has happened yet.
5. Supply the master account, supported account mode and approved exposure/margin
   policy. Implement independent execution metadata, leverage and open-order reads.
6. Implement and test authenticated live report delivery and signer-only exchange
   transport. Reconcile status/fills by client ID after ambiguity and restart;
   never infer fills from requested sizes or blindly resend an unknown order.
7. Configure :x9 snapshot publishing, ten-minute workflow scheduling, watchdog,
   Supabase persistence and Telegram delivery; run pause and flatten drills.
8. Obtain explicit funded-canary authorization with capital/risk limits, then run
   and reconcile the intended account's small live order. This is not covered by
   local fixtures or a successful compile.

`backend/src/readiness.ts` is a deployment checklist, not trading authority. Artifact
claims must be independently verified; no boolean or local test switches live on.

## Local checks

`pnpm typecheck`, `pnpm test`, `pnpm test:cre`, `pnpm paper:smoke`,
`pnpm compile:review-spike`, `pnpm compile:mirror-spike`, and
`python tests/validate_contracts.py` (with jsonschema installed).

Server code and CRE handlers have separate TypeScript scopes because CRE globally
restricts Node APIs. `erasableSyntaxOnly` catches unsupported Node strip-only syntax.
Do not import server HTTP, filesystem, SQL, timers or crypto modules into CRE.
The runtime policy interpreter uses the canonical flat JSON schema without Ajv
code generation; parity tests exercise every policy field's boundaries.

Sources checked 2026-10-06:
- [Hyperliquid tick and lot rules](https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/tick-and-lot-size)
- [Hyperliquid account queries/order status](https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/info-endpoint)
- [Hyperliquid asset IDs](https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/asset-ids)
- [CRE consumer identity and metadata](https://docs.chain.link/cre/guides/workflow/using-evm-client/onchain-write/building-consumer-contracts)

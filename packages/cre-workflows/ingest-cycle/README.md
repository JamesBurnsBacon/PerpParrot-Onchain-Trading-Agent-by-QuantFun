# Ingest cycle — local CRE simulation

This workflow connects the local Top 100 worker to CRE's native HTTP and consensus runtime. It submits the current ten-minute job idempotently, fetches the latest complete receipt, checks its SHA-256, 100 unique selected/next addresses, strict-Score marker and freshness, and returns a small consensus result.

Start the [backend worker](../../../docs/ingest/TOP100_LOOP.md) and wait for `http://127.0.0.1:8790/health` to report `ready`. The backend owns the slow API collection and scoring. The workflow performs three HTTP calls and passes only a small receipt acknowledgement through consensus.

From this directory:

```bash
bun install
bunx cre-setup
bun run typecheck
bun test
```

From `packages/cre-workflows` (with an already logged-in CRE CLI):

```bash
cre workflow simulate ingest-cycle --target local-simulation --non-interactive --trigger-index 0
```

Cron is `0 */10 * * * *`. The simulator fires once immediately. A successful same-bucket result has `mode: local-simulation` and `status: current-batch-verified`. If the current collection is pending, the result says `previous-batch-verified-current-requested` and includes both the requested and verified IDs. Before any complete batch exists, simulation fails with the backend's unavailable response.

`config.local-simulation.json` permits only a loopback backend and a maximum publication age of 15 minutes. Collection span must be at most nine minutes. The target uses the private registry selector. CLI 1.37 also requires one configured RPC even though this workflow has no EVM capability; the project uses its existing public Hyperliquid RPC.

There is no report, receiver, signer, exchange call or on-chain write path. Do not add `--broadcast` or deploy this target. A local simulation verifies the integration; it is not a deployed multi-node DON run, and a valid backend receipt does not independently prove the upstream financial data.

# Historical API and provider observations — 2026-10-06/07

These are the dated research observations formerly embedded in the root README.
Counts, latencies, API capabilities, prices and provider recommendations describe the
original checks; they are not current service guarantees or deployment settings.
Current product behavior: [README](../../README.md). Current routing and operator
procedures: [DEPLOY.md](../ops/DEPLOY.md). No runtime depends on this document.


### Hyperliquid data
- **Leaderboard:** `GET https://stats-data.hyperliquid.xyz/Mainnet/leaderboard`. Undocumented static file, refreshed every few minutes.
  - **~40 MB, 47,495 rows.** Downloads take 35 s to 2 min+, which is probably why the [UI](https://app.hyperliquid.xyz/leaderboard) fails to load.
  - Each row has `ethAddress`, `accountValue`, `displayName`, and `pnl` / `roi` / `vlm` for `day` / `week` / `month` / `allTime`.
  - 20.9k rows have ≥ $10k account value. 14.5k have ≥ $10k *and* positive month + all-time PnL.
- **Vault list:** `GET https://stats-data.hyperliquid.xyz/Mainnet/vaults` (~14 MB, ~11 s, undocumented).
  - 9,476 vaults, 3,091 open. **234 / 82 / 26** open vaults have TVL ≥ $10k / $100k / $1M.
  - The HL docs call HyperCore vaults **legacy** (perps only, no spot/HIP-3, 10% leader profit share, 1-day depositor lockup).
- **Info API** (`POST https://api.hyperliquid.xyz/info`):
  - `portfolio`: account value + PnL history for `day` / `week` / `month` / `allTime` (+ `perp*` versions).
    - **Point counts vary by address.** Issue #1 sampled 20 leaderboard addresses (≥ $10k, positive month + all-time PnL) and found min / median / max of:
      - `day` 12 / 13 / 17
      - `week` 61 / 63 / 66
      - `month` **26 / 44 / 48**
      - `allTime` **35 / 56 / 104**
    - The spacing is irregular, so compute returns on actual timestamps.
    - The same check confirmed 47,466 leaderboard rows, 234 open vaults with TVL ≥ $10k, 71 markets ≥ $20M OI (38 core + 33 HIP-3), and `eth_getCode` working on `https://rpc.hyperliquid.xyz/evm`.
  - `clearinghouseState` gives positions. `userFillsByTime` gives fills; only the 10k most recent are reachable, and older fills are in the requester-pays S3 bucket `hl-mainnet-node-data`. Also `userFunding` and `vaultDetails`.
- **Rate limits:** 1200 weight/min per IP. Most info calls cost 20; `clearinghouseState` / `allMids` cost 2.
- **HyperTracker** (CoinMarketMan): paid API with a free tier of 100 tokens/day, then $179–$1,999/month.

### Hyperliquid execution
- **Markets ≥ $20M OI on 2026-10-06:** 71 total.
  - 38 core perps, all of which allow cross margin.
  - 33 HIP-3: 32 on the `xyz` dex + `io:ANTH`, all with USDC collateral (`collateralToken` 0).
  - **12 HIP-3 markets are isolated-only:** CBRS, MSTR, HOOD, SOXL, CXMT, JPY, SMSN, NBIS, ORCL, ZHIPU, EUR (`noCross`); `io:ANTH` (`strictIsolated`).
  - HIP-3 max leverage ranges 6–50x (10x is common). MSFT sits just above the floor at $20.8M.
  - Source: `perpDexs` + `metaAndAssetCtxs` with a `dex` parameter.
- The minimum order is **$10**.
- API (agent) wallets sign orders and other L1 actions. Withdrawals and transfers need the master wallet.
- **Collateral:** standard perps margin is USDC.
  - HIP-3 markets can use other quote assets.
  - Portfolio margin (HYPE at LTV 0.65) needs > $10k account value or > $5M volume.
  - HYPE/USDC spot is `@107` (order asset id 10107).
- There is no official TS SDK. `@nktkas/hyperliquid` is the best-maintained community SDK and is listed in the HL docs.

### ERC-4626 vaults on HyperEVM
- This is the approach the HL team recommends now. Most of these vaults are lending/yield vaults (Felix/Morpho, Hyperbeat/Midas, Euler, HyperLend). A few are strategy vaults (Liminal basis, Harmonix, D2 Finance).
- DefiLlama yields API (chain "Hyperliquid L1"): 529 pools, 75 with ≥ $1M TVL.
- When a vault trades on HyperCore via CoreWriter, its HyperCore account shares the contract's address, so on the leaderboard it **looks like a normal address**. Hence the `eth_getCode` check.

### NOWNodes observations and original integration options
- **Available integrations** (opt-in and off by default; each needs `NOWNODES_API_KEY` plus the flag named in its bullet; with nothing set the backend uses Hyperliquid only, as before):
  - **Failover**: with `INFO_ROUTING=overflow`, an official-API read that fails (429, 5xx, timeout) is retried on NOWNodes for the eight methods it serves (`packages/backend/src/pipeline/info-router.ts`).
  - **Shadow check**: `INFO_SHADOW_PERCENT=N` compares N% of official `clearinghouseState` reads with NOWNodes in the background (account value, position count).
  - **First choice for bulk reads**: with `PICK_OVERLAP_GUARD=on`, the top 60 candidates' positions are read NOWNodes first (in a local benchmark on 2026-10-07, about 120 reads took ~2 s, all on NOWNodes, so none of the official API's 1,200 weight/min; a read that falls back to the official API does count against it) so the pick can leave out candidates that overlap one already chosen (`packages/backend/src/pipeline/overlap-pick.ts`).
  - **Dashboard**: the Pipeline panel shows reads, latency and failovers per provider when NOWNodes is in use, and the overlap guard's summary above the finalists table.
  - **Snapshot cross-check** (`SNAPSHOT_VERIFY=on|strict`): before a mirror snapshot is stored, every source's positions are read again from NOWNodes and compared asset by asset; a confirmed difference stores nothing and fails the run, so the executor never sizes orders from it (`packages/backend/src/snapshot-verify.ts`). It guards against a provider-side fault, not against Hyperliquid's own errors, and it does not cover `portfolio` equity.
  - **Contract check** (`CONTRACT_CHECK=on`): each pick's `eth_getCode` on NOWNodes' HyperEVM endpoint (`/evm`), recorded with the run and marked on the dashboard (`packages/backend/src/pipeline/contract-check.ts`). It shows which picks have code on HyperEVM; it does not show whether they trade. On 2026-10-07, 8 of the top 300 candidates by month PnL had code in the first run and 7 in a later run the same day, and NOWNodes and the public RPC agreed on contract-or-not for all 300 in the first run. At the later check, those 7 addresses had no open perp positions and no fills in the preceding 24 hours, so there were no current positions to copy. This is one day and a small sample, and why their leaderboard account value is large is not explained (issue #84). Evidence only; nothing is excluded.
  - **Capability probe** (`NOWNODES_PROBE=on`): which of 16 info methods NOWNodes answers, next to the router's allowlist; it can only narrow the allowlist (`packages/backend/src/pipeline/capability-probe.ts`, `scripts/probe-nownodes.ts`).
  - **Failure demo**: `packages/backend/scripts/chaos-read-demo.ts` injects an outage into the official API on a simulated network and compares the default routing with `overflow`.
  - **Limits, stated plainly**: NOWNodes is slower per read (below) and does not serve `portfolio` or fills, so the existing paths stay on Hyperliquid; the defaults are Hyperliquid only; the guard's effect on returns is not measured.
- `hype.nownodes.io` has two parts (key in the `api-key` header; measured 2026-10-07):
  - **HyperEVM JSON-RPC** at `/evm` (`eth_blockNumber` answers; `/` is a 404).
  - **A copy of HL's Info API** at `/info`. It serves `meta`, `perpDexs`, `clearinghouseState`, `spotClearinghouseState`, `webData2`, `userVaultEquities`, `spotMeta` and `vaultSummaries`.
- It answers 422 for `portfolio`, `userFillsByTime`, `userFunding`, `metaAndAssetCtxs`, `vaultDetails`, `allMids`, `l2Book` and `candleSnapshot`, so the selection pipeline's heavy reads (`portfolio`, fills) stay on Hyperliquid. No `/exchange`, so orders go to HL directly.
- In the recorded benchmark, NOWNodes was about 1.7x slower per read (median 0.36 s vs 0.21 s). Routing is configurable: `official` is the default, `overflow` retries supported failed reads, and `split` with `INFO_SPLIT_PERCENT=100` makes supported reads NOWNodes-first with official fallback. Check deployed settings and `/pipeline` metrics; see [the current deploy guide](../ops/DEPLOY.md).
- Paid plans advertise unlimited requests per second. It needs an API key. [Docs](https://docs.nownodes.io/hype)

### Coinbase AgentKit
- No Hyperliquid action provider. Its TS providers include `vaultsfyi`, `morpho`, `defillama`, `across`, `erc20`, `x402`. Not used.

### References
- HL: [info endpoint](https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/info-endpoint) · [rate limits](https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/rate-limits-and-user-limits) · [nonces & API wallets](https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/nonces-and-api-wallets) · [vaults](https://hyperliquid.gitbook.io/hyperliquid-docs/hypercore/vaults) · [portfolio margin](https://hyperliquid.gitbook.io/hyperliquid-docs/trading/portfolio-margin)
- Data: [HL leaderboard](https://app.hyperliquid.xyz/leaderboard) · [hyperliquidvaults.com](https://hyperliquidvaults.com) · [HyperTracker](https://hypertracker.io) · [DefiLlama yields](https://yields.llama.fi/pools) · [tradingstrategy.ai ERC-4626 list](https://web3-ethereum-defi.tradingstrategy.ai/tutorials/erc-4626-vault-list)
- SDKs: [`@nktkas/hyperliquid`](https://github.com/nktkas/hyperliquid) · [Coinbase AgentKit](https://github.com/coinbase/agentkit)

# PerpParrot 🦜

> Copy the best Hyperliquid perps traders and vaults, picked by quant screens and an AI agent, orchestrated by Chainlink CRE.
>
> **TOKEN2049 Origins Hackathon** · Tracks: **Chainlink (CRE)** · **AI x Crypto** · Status: design doc, no code yet

**TL;DR**
- Score Hyperliquid addresses (traders, HyperCore vaults, ERC-4626 vaults) on risk-adjusted performance.
- An LLM agent picks **5–25 source wallets**. Two models are compared in the backtest, and the winner runs live.
- Every 10 minutes, Chainlink CRE verifies the sources' positions and emits a signed rebalance report.
- An executor holds the **weighted, netted** copy of those positions in our own Hyperliquid account (5 HYPE ≈ $470).
- **The backtest is the proof:** out-of-sample results over 2 weeks, 1 month, 6 weeks and 3 months vs. holding BTC. The ~5 h live run proves the machinery.

---

# Part 1: Design

## 1. Scope
- **Build:** 36 h, from **Tue 6 Oct 12:00** to **Thu 8 Oct 00:00 SGT**. Team of 3–4. The demo is a **recorded video, ≤ 3 min**.
- **Live:** go live at **~Wed 19:00 SGT**, so ~5 h and ~30 mirror runs. Keep running through judging.
- **Non-goals:**
  - managing other people's money
  - live deposits into vaults or lending
  - a token
  - mobile
  - HFT-grade latency
  - guaranteed returns

**Video (≤ 3 min):**
1. **Funnel:** ~14.5k "profitable" addresses → filters → source set, and why most fail.
2. **Backtest** vs. BTC: the value claim.
3. **Finalist drill-down:** metrics, the agent's rationale, red flags.
4. **Live:** CRE run log, HyperEVM hashes, fills, per-source PnL.

## 2. Terminology
| Term | Meaning |
|---|---|
| **Source wallet** | An address we copy: a trader, a HyperCore vault, or the HyperCore account behind an ERC-4626 vault. We copy 5–25 of them. |
| **Slice** | Our scaled copy of one source's position in one asset, kept in a **virtual ledger** per (source, asset). |
| **Position** | Our actual net holding per asset, i.e. the sum of its slices. **The bottleneck:** ≈ $470 and a $10 minimum order allow ~5–10 net positions. |
| **Bucket** | A risk tier: a source universe, weights, and a leverage policy. |

## 3. Architecture
```
 BACKEND (Railway)
 ┌──────────────────────────────┐
 │ leaderboard + vault list     │
 │ ingest → label → score       │──────┐
 │ backtest · ledger            │      │
 │ positions snapshot API       │      │
 └──┬───────────────────────────┘      │
    │ shortlist                        │ positions
    v                                  │
 CRE: review (hourly)                  │
 ┌──────────────────────────────┐      │
 │ LLM agent (2 models)         │      │
 │ monitor sources, flag        │      │
 │ risks, write rationale       │      │
 └──┬───────────────────────────┘      │
    │ notes                            │
    v                                  │
 CRE: mirror (every 10 min)            │
 ┌──────────────────────────────┐      │
 │ fetch positions snapshot (1) │<─────┘
 │ spot-check ~10 sources (HL)  │
 │ slices → net → diff vs. ours │
 │ report() → executor+HyperEVM │
 └──┬───────────────────────────┘
    │ signed report
    v
 EXECUTOR (serverless)
 ┌──────────────────────────────┐
 │ verify DON signature         │
 │ dedupe report ID             │──> Hyperliquid (our account)
 │ sign w/ API wallet           │
 └──┬───────────────────────────┘
    │ fills / PnL / ledger
    v
 Supabase  <── backend also writes here
    │
    v
 Dashboard (Next.js on Vercel)
```

## 4. Components

### 4.1 Ingest (backend)
- **Universe:**
  - the leaderboard file (~47.5k addresses)
  - the HyperCore vault list (~3.1k open)
  - keep only those with ≥ $10k account value / TVL
- **Kind labeling:**
  - HyperCore vault if it's in the vault list.
  - **ERC-4626 vault** if `eth_getCode` on HyperEVM returns code *and* `asset()` / `totalAssets()` succeed. This runs on the shortlist only.
  - Trader otherwise.
- **History:** `portfolio` PnL history for the pre-filtered top few hundred.
- Cache the leaderboard every few hours and save every snapshot.

### 4.2 Score (backend)
- **Hard filters:**
  - ≥ $10k
  - ≥ 30 days active
  - ≥ 10 trades
  - not closed
  - **≥ 25 points in the `portfolio` `month` window**. History length varies a lot by address (issue #1), so "≥ 30 days active" alone doesn't guarantee enough points for Sortino/Calmar. Short-history addresses are **excluded**, with no fallback metric.
- **Score = average percentile rank** of 30-day **Sortino**, **Calmar / −max drawdown** and **PnL consistency**. Computed from PnL history, so deposits and withdrawals don't count as returns. **Top ~25 → finalists.**
- **Also computed** for the agent:
  - realized volatility and average leverage
  - time in market and holding times
  - **maker/taker volume split** (from `crossed` on fills, or `userFees`; verify). A high maker share suggests sophistication, but market-maker inventory may not be copyable. ❓ *Plus or exclusion?*

### 4.3 Buckets
| Bucket | Source universe | Exposure | Hackathon mode |
|---|---|---|---|
| **Aggressive** | Traders + vaults | Mirrored exactly, subject to the 95% margin rule (§4.8) | **Live** |
| **Balanced** | Same set as Aggressive | Aggressive × `m < 1`. ❓ *`m` is tuned from the backtest to a target vol/drawdown.* | Backtest + paper |
| **Conservative** | **Separate low-risk universe: vaults + lending only** | Copies the sources' perp **and lending/yield** positions. ❓ *How do we read lending positions, now and historically?* | Backtest + paper |

### 4.4 Copy model
- **Slice:** `slice_i,c = wᵢ' × (nᵢ,c / Eᵢ) × E_ours`.
  - `nᵢ,c` is source *i*'s signed notional in asset `c`.
  - `Eᵢ` is the source's *current* equity, so its deposits and withdrawals don't distort our size.
- **Flat is not a signal:** `wᵢ' = wᵢ / Σ_active wⱼ`, i.e. weights are renormalized over sources that currently hold positions.
- **Position** in asset `c` = `Σᵢ slice_i,c`, netted at order time.
- **Trade a leg only if** the gap is **≥ $10 and ≥ 10%** of the target.
- **Ledger = target, account = truth.** Every run diffs against the real account, so partial fills, skipped legs and partial liquidations self-correct. Per-source PnL attributes fills pro-rata.
- **Eligible assets:**
  - validator perps + **USDC-collateral HIP-3** with **≥ $20M OI** (a line that just includes Microsoft)
  - excluding **isolated-only** markets
  - That's **59 assets** on 2026-10-06. Everything else is skipped, which counts as tracking error.
  - The OI floor is checked at go-live, then daily.
  - **Hysteresis:** an asset becomes eligible at ≥ $20M OI and stays eligible until it falls **below $15M**. This stops borderline markets from flipping in and out; e.g. `xyz:MSFT` sat at ~$20.8M (issue #1).
  - **If an asset we hold loses eligibility** at a daily check, its slices become **reduce-only**: we follow sources' reductions and closes, the same pattern as type-A removal.

### 4.5 Source-set changes
**Hackathon: the set is fully frozen at go-live.** The agent only monitors.

**Production** (reselection daily or weekly):

| Type | Trigger | Handling |
|---|---|---|
| **A: edged out** | A better performer takes the spot | Recompute targets with the new mix. Legs misaligned with the new allocation become **reduce-only**, following the old source's reductions and closes so nothing is orphaned. After **24 h**, DCA out in **3 trades over 3 h**. |
| **B: performed badly** | The source's own drawdown from peak is ≥ N%, with **N set per tier** (❓ values) | **Immediate exit** of its slices on the next run |

### 4.6 AI layer: the agent in the CRE `review` workflow (hourly)
A dedicated workstream, integrated into the CRE flow.
- **Before go-live:** the agent picks **5–25 sources from ~25 finalists**, assigns weights, and writes a rationale and red flags (martingale, wash-like behavior, concentration, near-liquidation). It also judges:
  - **diversification**, from the correlation matrix and vault ↔ leader links
  - **time in market** (avoid often-flat sources)
  - **holding time** (too fast to copy at a 10-minute delay?)
- **After go-live:** monitoring and commentary only.
- **Inputs per finalist:**
  - metrics and kind
  - an equity-curve summary (the `month` window: 26–48 points)
  - current positions (size, leverage, distance to liquidation)
  - trade patterns
  - time in market
  - maker/taker split
  - plus the correlation matrix
  - **Budget:** ≈ 25 × ≤ 4 KB, under CRE's 120 KB request limit.
- **Models:** two (≥ 1 from OpenAI; ❓ which). The backtest winner selects the live set, and the loser is **shadow-tracked on paper**. Output is structured JSON. API keys are CRE secrets.
- **Consensus:** default is **every DON node calls the model, with per-field consensus**. ❓ *Still open vs. a single cached call (`cacheSettings`).*
- **Output format:** ❓ *a weight grid (0–3 units), continuous weights with median consensus, or a ranking plus a formula.*
- **Logging:** full prompts and outputs go to Supabase with their hashes.
- **First deliverable:** a CRE `review` spike proving an LLM call plus consensus works in `cre workflow simulate`. Then schemas in `packages/shared`, a prompt + offline eval, and the point-in-time backtest harness.

### 4.7 Mirror (CRE workflow, every 10 min: `0 */10 * * * *`)
1. Fetch the **positions snapshot** for all sources (1 call). The backend refreshes it at `:x9`, just before each run.
2. **Spot-check** ~10 random sources plus our account via `clearinghouseState`. **Reject the run if any source's notional differs by more than 5% of its equity.**
3. Slices → net → diff → drift rule.
4. `report()` → executor, plus the hash → HyperEVM consumer contract.

That is ≤ 13 HTTP calls, under CRE's limit of 15.
- **On failure** (consensus, spot-check, timeout): hold positions, retry on the next run, and send a Telegram alert after 2 consecutive failures. There is no backend fallback.
- **Freeze commitment:** before the first live trade, `review` writes a hash of the frozen set + weights to HyperEVM.

### 4.8 Execute (serverless executor)
- **Checks:**
  - verify the DON signature
  - dedupe by report ID (HL nonces back this up)
  - **sanity bounds:** the source set must match the frozen set, and total notional must stay ≤ e.g. 50× equity
- **Orders:** IOC limit at mark ± a slippage cap. Remainders are retried on the next run.
- **Leverage:** cross margin; each asset at its **max leverage** (`updateLeverage`; many HIP-3 markets are 10x, BTC up to 40x). Exposure is mirrored exactly.
  - If initial margin `Σ |N_c| / maxLev_c` would exceed **95% of equity**, scale **all** targets down pro-rata.
- **Keys:** a fresh EOA. A human holds the master key; the executor holds only an **HL API wallet** key (trade, no withdraw).
- **Kill switch:** manual only. Any team member can press it (Supabase auth).
  - **Pause:** stop trading, keep positions.
  - **Flatten:** close everything.
- **Alerts:** a Telegram bot.
- **Capital:** 5 HYPE, currently on HyperEVM.
  - Keep **0.1 HYPE** there for contract gas.
  - Send ~4.9 HYPE to HyperCore via the system address `0x2222…2222` (verify).
  - Swap it to **USDC on spot** (`@107`). Portfolio margin needs $10k, and we have just under $500.

### 4.9 Backtest (backend): the main value claim
- **Return-based:**
  - Portfolio return ≈ `Σ wᵢ · rᵢ`, which follows from equity-ratio scaling.
  - Subtract a **turnover-based haircut** (HL taker fee + slippage bps per unit of turnover).
- **In-sample** = all history before the cut. **Out-of-sample** = the last **2 weeks, 1 month, 6 weeks and 3 months**, one cutoff each, compared with holding BTC.
- **Algo-only vs. model A vs. model B:**
  - Prompts are **anonymized** (no addresses, names or dates) and **truncated** at the cut, so the models can't recall wallets or events.
  - Point-in-time positions and trade patterns would need fills (≤ 10k most recent), so the backtest agent may see only metrics + the equity curve. Disclose this.
- **Disclosures:**
  - **Survivorship:** the leaderboard is a current snapshot.
  - **Copy delay:** the backtest assumes instant copies. Live delay can move prices either way (tracking error) and misses very short trades.
  - **Resolution:** `month` has 26–48 points (≈ every 15–28 h) and `allTime` 35–104 points (≈ weekly for recent accounts). The resolution varies by address, so metrics must handle irregular spacing.
- *Stretch:* fills-based replay with the 10-minute delay, the $10 minimum and netting.

### 4.10 Paper books (backend only)
- **Books:** Balanced, Conservative, the shadow model, and a $10k twin of live Aggressive.
- **Sizes:** each at **~$470 and $10k**, to show the strategy both with and without the minimum-order effect.
- **Fills:** at HL mark price, plus the taker fee, plus the backtest slippage, with the $10 minimum applied.

### 4.11 Dashboard (Next.js + Tailwind on Vercel): public, read-only
- **Landing:** the backtest vs. BTC (algo-only, model A, model B).
- **Also:**
  - the funnel
  - finalist drill-down
  - buckets and paper books
  - live positions vs. targets
  - per-source PnL
  - the CRE run log with HyperEVM hashes
- The Pause/Flatten admin actions sit behind auth.

### 4.12 Module contracts
| Module | Input | Output |
|---|---|---|
| `ingest` | leaderboard, vault list, HL Info API, HyperEVM RPC | `snapshots` |
| `score` | `snapshots` | `candidates` (filters, metrics, score) |
| `backtest` | `snapshots`, `candidates`, agent picks | `backtests` per OOS window |
| `review` (CRE) | finalists | `reviews`, `buckets`, freeze hash |
| `positions` | source set | positions snapshot API |
| `mirror` (CRE) | snapshot + spot-checks + `ledger` | signed report + HyperEVM hash |
| `execute` | report | `orders`, `fills`, `ledger` |
| `paper` | snapshot, buckets, mark prices | `paper_books` |
| `dashboard` | all tables | — |

## 5. Stack
| Layer | Choice |
|---|---|
| Language / repo | TypeScript. **pnpm monorepo:** `packages/{backend, cre-workflows, executor, dashboard, contracts, shared}`. No license yet. |
| Hyperliquid | [`@nktkas/hyperliquid`](https://github.com/nktkas/hyperliquid) in the backend and executor; raw HTTP inside CRE |
| Prices | Hyperliquid oracle/mark prices via the Info API (`metaAndAssetCtxs`). BTC history from `candleSnapshot`. No Chainlink Data Feeds. |
| Orchestration | Chainlink CRE (`@chainlink/cre-sdk`, `cre` CLI), DON access from the sponsor on-site. Consumer contract on HyperEVM. |
| AI | Two LLMs (≥ 1 OpenAI), structured JSON |
| Storage / hosting | Supabase. Backend on Railway (the leaderboard download is too slow for serverless). Executor + dashboard on Vercel. |
| Secrets | Railway/Vercel env vars plus CRE secrets. `.env.example` only in the repo. |
| Testing | Fixtures, then $10–20 mainnet runs before the freeze. No testnet. |
| Optional / unused | NOWNodes (HyperEVM RPC + an Info API copy) if it helps with rate limits; not a track. No AgentKit. |

## 6. Timeline (SGT)
Budget ~1 h of testing per 2 h of features. Integrate only tested modules.

| When | Milestone |
|---|---|
| **Before Tue 12:00** | Handoff notes (one member is away midday Tue): scaffold, Supabase schema, env vars, task split |
| Tue 12–16 | DON access · wallet + API wallet · move and swap HYPE · spikes: `portfolio`, $10 IOC order, CRE in simulation, LLM-in-CRE |
| Tue 16–24 | `ingest` + `score` · kind labeling · start saving snapshots |
| Wed 00–08 | `backtest` (4 windows, algo vs. model A vs. model B) · `review` workflow |
| Wed 08–15 | `positions` · `mirror` · executor + ledger · end-to-end tiny-size run |
| Wed 15–19 | Dashboard · HyperEVM contract · paper books · **freeze + commit the set** |
| **Wed 19:00** | **Go live.** Gate: backtest winner chosen, set committed, and a $10–20 end-to-end run passed |
| Wed 19–Thu 00 | Monitor, record the video. Make the README judge-facing and move design content to `docs/DESIGN.md`. Submit. |

## 7. Risks
- **Liquidation:** there is no leverage cap or automatic halt. Mitigated only by the 95% margin rule. *Accepted:* small capital, Pause/Flatten, alerts, monitored.
- **Backtest optimism:** survivorship and the instant-copy assumption → disclosed; our own snapshots start a forward record.
- **Short live window** → the value claim rests on the backtest.
- **$10 minimum vs. ≈ $470** → ~5–10 positions and tracking error, shown on the dashboard.
- **Slippage** → IOC orders, slippage cap, drift rule, $20M OI floor.
- **No testnet** → fixtures plus tiny mainnet runs.
- **Undocumented endpoints** → cached snapshots; HyperTracker/NOWNodes as fallbacks.
- **Duplicate orders** → report-ID dedupe plus HL nonces.

## 8. Open questions
- [ ] ❓ Which two models (≥ 1 OpenAI)
- [ ] ❓ LLM in CRE: every node + per-field consensus (default) vs. a single cached call
- [ ] ❓ Agent output format: weight grid, continuous weights, or ranking
- [ ] ❓ Maker share: a plus or an exclusion?
- [ ] ❓ Balanced multiplier `m` (from the backtest)
- [ ] ❓ How to read sources' lending positions for Conservative
- [ ] ❓ Per-tier type-B threshold N (production)

---

# Part 2: Research notes (checked 2026-10-06)

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

### Chainlink CRE
- **SDK:** TypeScript SDK `@chainlink/cre-sdk` (v1.x), Go also supported. Not formally GA yet. Workflows run on QuickJS/WASM, so there is no `node:crypto` (use Noble/viem).
- **Cron:** 5- or 6-field expressions, minimum interval 30 s.
- **Quotas per run:**

  | Limit | Value |
  |---|---|
  | Run time | 5 min |
  | Memory | 100 MB |
  | HTTP calls | 15 |
  | Response size | 250 KB |
  | Request size | 120 KB |
  | Data into consensus | 25 KB |
  | Secret fetches | 5 |

- **HTTP:** every node sends every request by default. `cacheSettings` makes a POST single-send, but only best effort.
  - GET results are aggregated with identical, median, or per-field consensus.
- **LLM output** has to be structured JSON, with consensus run per field.
- **Secrets** are decrypted into every node's memory. That's why signing happens in the executor, not in CRE. Chainlink's portfolio-rebalancing template uses the same split.
- **Writes:** ~24 EVM chains, **including HyperEVM** (TS SDK v1.4.0+). Reports go through a forwarder to a consumer contract, max 50 KB.

### NOWNodes (optional infra)
- `hype.nownodes.io` has two parts:
  - **HyperEVM JSON-RPC:** `eth_getCode`, `eth_call`, `eth_getLogs`, `eth_sendRawTransaction`, …
  - **A copy of HL's Info API:** `clearinghouseState`, spot state, vault summaries, user vault equities, `webData2`, …
- Missing from the Info API copy: `portfolio`, fill history, `userFunding`. No `/exchange`, so orders go to HL directly.
- Paid plans advertise unlimited requests per second. It needs an API key. [Docs](https://docs.nownodes.io/hype)

### Coinbase AgentKit
- No Hyperliquid action provider. Its TS providers include `vaultsfyi`, `morpho`, `defillama`, `across`, `erc20`, `x402`. Not used.

### References
- HL: [info endpoint](https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/info-endpoint) · [rate limits](https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/rate-limits-and-user-limits) · [nonces & API wallets](https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/nonces-and-api-wallets) · [vaults](https://hyperliquid.gitbook.io/hyperliquid-docs/hypercore/vaults) · [portfolio margin](https://hyperliquid.gitbook.io/hyperliquid-docs/trading/portfolio-margin)
- CRE: [service quotas](https://docs.chain.link/cre/service-quotas) · [HTTP client (TS)](https://docs.chain.link/cre/reference/sdk/http-client-ts) · [non-determinism](https://docs.chain.link/cre/concepts/non-determinism-ts) · [supported networks](https://docs.chain.link/cre/supported-networks-ts) · [deploy access](https://docs.chain.link/cre/account/deploy-access) · [portfolio-rebalancing template](https://docs.chain.link/cre-templates/automated-portfolio-rebalancing)
- Data: [HL leaderboard](https://app.hyperliquid.xyz/leaderboard) · [hyperliquidvaults.com](https://hyperliquidvaults.com) · [HyperTracker](https://hypertracker.io) · [DefiLlama yields](https://yields.llama.fi/pools) · [tradingstrategy.ai ERC-4626 list](https://web3-ethereum-defi.tradingstrategy.ai/tutorials/erc-4626-vault-list)
- SDKs: [`@nktkas/hyperliquid`](https://github.com/nktkas/hyperliquid) · [Coinbase AgentKit](https://github.com/coinbase/agentkit)

# PerpParrot 🦜

> Copy the best Hyperliquid perps traders and vaults, picked by quant screens and an AI agent, orchestrated by Chainlink CRE.
>
> **TOKEN2049 Origins Hackathon** · Tracks: **Chainlink (CRE)** · **AI x Crypto** · Status: review core, CRE mirror path and executor built and simulated end to end; deploy gated on CRE access

**TL;DR**
- Score Hyperliquid addresses (traders, HyperCore vaults, ERC-4626 vaults) on risk-adjusted performance.
- An LLM agent picks **5–25 source wallets**. Two models are compared in the backtest, and the winner runs live.
- Every 10 minutes, Chainlink CRE verifies the sources' positions and emits a signed rebalance report.
- An executor holds the **weighted, netted** copy of those positions in our own Hyperliquid account (5 HYPE ≈ $470).
- **The backtest is the proof:** out-of-sample results over 2 weeks, 1 month, 6 weeks and 3 months vs. holding BTC. The ~5 h live run proves the machinery.

> **Where things are:** review core (AI): [architecture](docs/agents/ARCHITECTURE.md), [system prompts](docs/agents/SYSTEM_PROMPTS.md), [acceptance cases](docs/agents/EVALUATION.md), [JSON contracts](packages/shared/schemas), [integration guide](docs/agents/INTEGRATION.md); checks: `pnpm test`, `pnpm typecheck`. CRE mirror path: README §4.7–4.14, [runbook](docs/cre/RUNBOOK.md), [how the two branches were merged](docs/cre/INTEGRATION.md); checks: `bun test` per package, `./scripts/e2e-mirror.sh all`. **Live bucket: Aggressive** (§4.3).

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
4. **Live:** CRE run log with the DON-signed reports, fills, per-source PnL.

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
 │ sendReport() → executor      │
 └──┬───────────────────────────┘
    │ signed report
    v
 EXECUTOR (Railway)
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
  - **Daily snapshots:** save each tracked address's `month` points (in the `allTime` PnL baseline). `allTime` is coarse (7–14 days between points for older accounts), so this is the only way to get ~16-hour resolution beyond 30 days.
- **Fills** (trade count, leverage, holding times, maker share): only for addresses that pass the cheap filters.
- Cache the leaderboard every few hours and save every snapshot.

### 4.2 Score (backend)
- **Hard filters:**
  - ≥ $10k
  - ≥ 30 days active
  - ≥ 10 trades
  - not closed
  - **≥ 25 points in the `portfolio` `month` window**. History length varies a lot by address (issue #1), so "≥ 30 days active" alone doesn't guarantee enough points for Sortino/Calmar. Short-history addresses are **excluded**, with no fallback metric.
  - still active (a PnL change in the last 7 days)
  - no ruin in the lookback, and ≤ 20% of it in near-zero-equity ("dust") intervals
  - Missing data is **fail-closed**: an unknown filter fails unless that filter is explicitly allowed (e.g. trade counts before fills are ingested).
- **Lookback: 90 days** (30 days is the minimum history, not the window). The last 30 days come from the `month` window, older days from `allTime`, joined exactly on their shared timestamps; daily snapshots (§4.1) replace the coarse part over time.
- **Returns** are computed from PnL with flows backed out (`flow = Δaccount value − ΔPnL`), so deposits and withdrawals never count as returns. A deposit counts as capital for the whole interval, so a deposit into a near-empty account cannot create a huge return.
- **Score = weighted average percentile rank, within pool** (traders, vaults), in three equal blocks:
  - risk-adjusted return: **Sharpe** and **Sortino**
  - drawdown: **Calmar** and **−max drawdown**
  - **PnL consistency**: R² of the log equity curve against time (0 if it trends down)
- **Clone grouping before the cut:** accounts whose daily returns correlate ≥ 0.9 (❓ *tuned*), or that are known to be linked (vault ↔ leader, sub-accounts), are grouped and only the best-scoring one can be a finalist. Duplicates would concentrate the portfolio in one strategy's idiosyncratic risk.
- **Top ~25 distinct strategies → finalists**, with slots split between traders and vaults (❓ *split set in tuning*). Full definitions: `packages/backend/src/score/SPEC.md`.
- **Also computed** for the agent:
  - annualized return and volatility, all-time max drawdown (reported, not ranked)
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

Status: the offline review core (`packages/cre-workflows/review/workflow.ts`, role/risk/red-team committee with DON-node quorum) and a real-SDK review spike (`review-spike`: per-node structured output, per-field median consensus) are built; see [CRE_SPIKE.md](docs/agents/CRE_SPIKE.md) and [production integration status](docs/agents/PRODUCTION_INTEGRATION.md). Its output, a frozen configuration, is the mirror's only execution authority (§4.7). Authenticated model runs and the two-model evaluation remain.

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
- **Calling the model: every node, per-field consensus** (`review-spike`). The committee design needs one observation per DON node (quorum across nodes), so the review uses plain HTTP with per-field median consensus. A Confidential HTTP spike (one enclave call, key never on nodes; passed in simulation 2026-10-06) was dropped in the merge because a single call can't give per-node observations.
- **Output format:** ❓ *a weight grid (0–3 units), continuous weights with median consensus, or a ranking plus a formula.*
- **Logging:** full prompts and outputs go to Supabase with their hashes.
- **First deliverable:** a CRE `review` spike proving an LLM call plus consensus works in `cre workflow simulate`. Then schemas in `packages/shared`, a prompt + offline eval, and the point-in-time backtest harness.

### 4.7 Mirror (CRE workflow, every 10 min: `0 */10 * * * *`)
Each node runs steps 1–3 (`runInNodeMode`); the DON agrees per field, then signs and sends in step 4. Code: `packages/cre-workflows/mirror`, `packages/shared`.
1. **Fetch the positions snapshot** for this run: `GET {backendUrl}/snapshots/{runAt}` (1 call). The backend builds it at `:x9` and never changes it, so every node gets identical bytes (`packages/shared/snapshot.ts`).
   - Contents: the **frozen configuration** (below), the eligible-asset list, and per frozen source its equity and eligible positions (signed USD notional). Amounts are decimal strings × 1e6.
   - **Equity = HL's live account value** from the `portfolio` request (last point of the `day` window, live), not Σ per-dex `accountValue`. Most leaderboard traders use unified or portfolio-margin accounts (23 + 5 of 40 sampled), where per-dex `accountValue` is only the margin set aside on that dex; summing it understated equity, and so overstated leverage, by 2–10×. The portfolio value is also what the backtest's returns use.
   - The mirror rejects it if it's for another run, was taken > 120 s from `runAt`, contains an ineligible asset, doesn't cover exactly the frozen sources, or its configuration isn't the pinned one.
   - The backend only builds real run times (`:x0`) within 120 s of now, so nobody can pre-build a stale snapshot for a future run through the public endpoint.
2. **Spot-check 4 sources**: `clearinghouseState` on the core dex **and** `xyz` (HIP-3 positions only come back per dex) plus `portfolio` for equity, 3 calls each. The sample is seeded with HMAC-SHA256 keyed by `mirrorSamplingKey`, a CRE secret the snapshot service never sees, over the run time and the snapshot hash (from the review core's mirror spike). Every node computes the same sample; the backend can't predict it. Deviation = the larger of Σ |snapshot − live notional| and |snapshot − live equity|, over live equity. **Reject the run if the worst source exceeds 5%.**
3. **Exposures:** `exposure_c = Σᵢ wᵢ' · nᵢ,c / Eᵢ` per asset in bigint math (`packages/shared/copy.ts`), so every node gets identical results.
   - Weights are the frozen `weightUnits`; cash stays cash. Flat sources' weight goes to active ones (`wᵢ' = wᵢ · W_all / W_active`), but **never past a source's frozen ceiling** (the run fails instead). Gross exposure is capped at the policy's `maxGrossLeverage`.
   - **Consensus:** snapshot ID, snapshot hash, account and exposures are `identical`; the spot-check's max deviation is `median` (live reads differ slightly between nodes). Only ≤ 59 exposures go through consensus, not the snapshot, which stays under the 25 KB limit (a 25-source snapshot can be ~60 KB).
4. **Report the exposures** → `report()` → `sendReport()` POSTs it to the executor (§4.13). The executor turns them into targets with our live equity (target = exposure × equity), then orders; the drift rule (§4.4) and the 95% margin rule (§4.8) run there, against the live account.

**HTTP calls: 14 of CRE's 15** (1 snapshot + 12 spot-check + 1 executor), enforced by the simulator. A failed call fails the run, and the next run retries.
- **Frozen configuration = execution authority.** The review core (branch `ai-agent-workflow`, `shared/src/frozen.ts`) turns a VALID/LIVE review into a `FrozenConfiguration`: sources with integer weight and ceiling units, cash units, **our account**, the policy, and a `configurationHash` (keccak over canonical JSON, domain `perpparrot:frozen:v1`). `packages/shared/frozen.ts` re-implements its checks without dependencies so they run in WASM; the fixture passes the review core's own validator.
- **Freeze commitment:** the `configurationHash` is pinned in `mirror`'s production config, so it's part of the deployed workflow ID, and it's inside every DON-signed report. The executor rejects any other hash. **No onchain contract:** everything trades in our own HL account, and the signed reports (executor `/runs`, dashboard) are the verifiable record; anyone can check them against the Capability Registry. Freezing = set the hash in `config.production.json`, redeploy `mirror` via CI, set the executor's `FROZEN_CONFIGURATION_HASH`, load the configuration into the backend.
- **On failure** (snapshot, consensus, spot-check, executor rejection, timeout): the run throws, the executor holds positions, and the next run retries. The executor alerts on Telegram after 25 min without a report (≈ 2 missed runs). There is no backend fallback.
- **Assets that lose eligibility:** the executor closes them (they're absent from the targets) rather than following sources' reductions (§4.4 reduce-only). Simpler, and HL allows reduce-only closes of any size; revisit if it costs too much.
- **Status (2026-10-06):** `scripts/e2e-mirror.sh all` passes six scenarios in simulation on live HL data, with a frozen set covering every HL account mode (4 standard vaults, 2 unified and 1 portfolio-margin trader with HIP-3 positions): the happy path (configuration verified in WASM, report verified, planned and signed in dry run), a paused executor, backend down, executor down, a mismatched configuration (HTTP 422) and a tampered snapshot (spot-check fails). At full size (25 leaderboard traders, 201 positions, 18 holding HIP-3) the snapshot is 12.8 KB (limit 250 KB) and the report carries 46 exposures; soak runs every 90 s against long-running services show 0–30 bps spot-check deviation for production-age snapshots. Not exercised until deploy: real multi-node consensus and the registry signature check.

### 4.8 Execute (executor service on Railway)
Code: `packages/executor`. One long-running Bun service (Railway, `Dockerfile` + `railway.json`), so there's one HL nonce sequence, an in-process run queue and no function timeout.
- **Intake** (`POST /reports`): verify the report (≥ f+1 DON signatures, pinned workflow owner, optionally workflow name and DON, §4.13), then check the configuration hash, our account, expiry and lifetime (≤ 300 s), dedupe by report ID, **answer 200 at once** and execute in the background (DON nodes time out after 10 s). Runs are queued and never overlap, even when one is slow; expiry is re-checked when a run starts. A run still going after 60 s is alerted on and cancelled before its next leverage update or order batch (batches already sent can't be recalled), and database queries time out after 10 s.
- **Plan** against the live account (`src/planner.ts`):
  - target = reported exposure × our live equity (HL portfolio value) for every eligible asset; anything we hold that isn't targeted goes to 0
  - **margin rule:** if `Σ |N_c| / maxLev_c` would exceed **95% of equity**, scale **all** targets down pro-rata
  - **drift rule:** trade a leg only if the gap is ≥ $10 and ≥ 10% of the target; full closes are always allowed (reduce-only)
  - reductions first; reduce-only whenever an order only shrinks a position
  - **sanity bound:** reject the report if gross exposure > 10× (the policy caps it at `maxGrossLeverage`, 3× in the fixture)
  - **own eligibility check:** never open, add to or flip a position in a market that isn't cross-margin with ≥ $15M OI by the executor's own reading, whatever the snapshot's list says (reductions still follow the sources)
  - the $10 minimum is checked at the IOC limit price
- **Orders:** IOC limit at mark ± 50 bps, prices and sizes rounded to HL tick/lot rules, ≤ 20 orders per action, a deterministic `cloid` per report and asset. Remainders are retried on the next run.
- **Leverage:** cross margin; each asset at its **max leverage** (`updateLeverage`, once per asset; many HIP-3 markets are 10x, BTC up to 40x). If HL refuses for one asset, only that asset's order is skipped.
- **Dry run by default:** orders are built and signed through `@nktkas/hyperliquid` exactly as they'd be sent, then recorded instead of POSTed. `DRY_RUN=false` plus `HL_API_WALLET_KEY` goes live.
- **Keys:** a fresh EOA. A human holds the master key; the executor holds only an **HL API wallet** key (trade, no withdraw).
- **Kill switch:** manual, bearer-token admin routes (any team member with `ADMIN_TOKEN`; the dashboard calls them behind auth).
  - **Pause / resume:** stop or restart trading, keep positions.
  - **Flatten:** pause, then close everything reduce-only, bypassing CRE.
- **Run log:** `GET /runs` (plans, order results, raw signed reports) and `GET /status`; stored in Supabase (`executor_runs`) when `DATABASE_URL` is set.
- **Alerts:** Telegram bot (`TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`) for failed runs, failed orders and missed reports.
- **Account mode: unified** (one USDC balance margins core and `xyz` perps; `scripts/setup-account.ts`). Equity and the margin rule use HL's account value, which is only all usable margin in unified mode.
- **Capital:** 5 HYPE, currently on HyperEVM.
  - Keep **0.1 HYPE** there for gas.
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

Status: built (`packages/backend/src/paper/`), stepped from every DON-agreed snapshot and served at `GET /paper`. Running now: Aggressive at $470 (live size), its $10k twin, Balanced at $470 (Aggressive's weights × 0.5, `PAPER_BALANCED_MULTIPLIER`) and BTC buy & hold. Books hold on runs the mirror's deterministic checks would refuse, and pay funding between runs at HL's current hourly rate. Conservative, the shadow model and the $10k Balanced book wait for the review core to emit their configurations; adding one is a `BookSpec` in `defaultBooks`.
- **Books:** Balanced, Conservative, the shadow model, and a $10k twin of live Aggressive.
- **Sizes:** each at **~$470 and $10k**, to show the strategy both with and without the minimum-order effect.
- **Fills:** at HL mark price, plus the taker fee, plus the backtest slippage, with the $10 minimum applied.

### 4.11 Dashboard (Next.js + Tailwind on Vercel): public, read-only

Status: built (`packages/dashboard`): live account vs paper books vs BTC, targets vs held with the executor's action per asset (last run), CRE heartbeat and run log (signed reports downloadable for `verify-run`), backtest vs BTC, funnel and finalists. Backtest, funnel and finalists render once their jobs publish to `dashboard_artifacts` (contract: `packages/shared/dashboard.ts`, RUNBOOK § Data for the dashboard). Not yet: per-source PnL, admin actions (Pause/Flatten stay on the executor's authenticated API).
- **Landing:** the backtest vs. BTC (algo-only, model A, model B).
- **Also:**
  - the funnel
  - finalist drill-down
  - buckets and paper books
  - live positions vs. targets
  - per-source PnL
  - the CRE run log with the raw signed reports, so anyone can verify them
- The Pause/Flatten admin actions sit behind auth.

### 4.12 Module contracts
| Module | Input | Output |
|---|---|---|
| `ingest` | leaderboard, vault list, HL Info API, HyperEVM RPC | `snapshots` |
| `score` | `snapshots` | `candidates` (filters, metrics, score) |
| `backtest` | `snapshots`, `candidates`, agent picks | `backtests` per OOS window |
| `review` (CRE) | finalists | `reviews`, `buckets`, freeze hash |
| `positions` | source set | positions snapshot API |
| `mirror` (CRE) | snapshot + spot-checks | signed report |
| `execute` | report | `orders`, `fills`, `ledger` |
| `paper` | snapshot, buckets, mark prices | `paper_books` |
| `dashboard` | all tables | — |

### 4.13 Mirror → executor report
- **Transport:** `runtime.report()` (`evm` / `ecdsa` / `keccak256`), then `sendReport()` POSTs JSON `{report, context, signatures}` (hex, no `0x`) to the executor. **Every DON node POSTs its own copy.** `cacheSettings` only trims duplicates, because each node's signatures differ. The mirror reaches consensus on the executor's HTTP status, so it fails loudly on a rejection.
- **Body** (ABI-encoded after the 109-byte header, `packages/shared/report.ts`): `string runId, bytes32 snapshotHash, bytes32 configurationHash, address account, uint64 asOf, uint64 expiresAt, (string asset, int256 exposureE9)[] exposures`.
  - **Exposures, not orders or USD targets.** Exposure = target notional as a fraction of our equity. The executor multiplies by our live equity and diffs against the live account when it runs, so price and equity moves between report and execution don't matter, and nodes never have to agree on prices, our equity or our positions.
  - The review core's `rebalance-report.schema.json` (branch `ai-agent-workflow`) puts ≤ 10 **orders** in the report instead. ❓ *§8: reconcile before merging.*
- **Report ID** = `keccak256(rawReport)`, identical across nodes. The first valid copy is accepted; later copies get `200 duplicate`.
- **Verification** in the executor (`src/verify.ts`, `src/handler.ts`):
  - ≥ f+1 signatures from the DON's signers, read from the Capability Registry `0x76c9cf548b4179F8901cda1f8623568b58215E62` on **Ethereum mainnet** (cached per DON ID; e.g. DON 1: f = 3, 10 signers). The executor needs an Ethereum mainnet RPC.
  - `workflowOwner` in the header = our **organization address** `0xc5feb3cf878c9ba42a776e9edf62a4558ab08b85` (private registry, §4.14; `cre whoami -v` → `derivedWorkflowOwners`), from `WORKFLOW_OWNER`. **Don't pin the workflow ID:** it is a hash of the binary + config and changes on every update.
  - Optionally the 10-byte workflow name field (`WORKFLOW_NAME`, copied from the first real report) and `DON_ID`, so another workflow of ours, e.g. `mirror-staging`, can't drive the production executor.
  - `configurationHash` = `FROZEN_CONFIGURATION_HASH`, `account` = `HL_ACCOUNT`, now ≤ `expiresAt`, `expiresAt − asOf` ≤ 300 s (our own cap, whatever the mirror config says), and `asOf` no more than 60 s ahead of our clock. Signer sets are re-read hourly; unknown DON IDs are remembered and lookups rate-limited.
- **Simulation:** `cre workflow simulate` signs with local test keys, which fail verification, and stamps the next `:x0` as `asOf`. `VERIFY_REPORTS=false` (simulation mode: signatures must still recover) is refused in production; `MAX_REPORT_LEAD_SECONDS=600` covers the early stamp.

### 4.14 CRE setup and team access
- **Organization** `PerpParrot`: James is the Owner. Ownership can't be transferred, and only the Owner can invite members. Teammates have been invited; members see every workflow, its runs and status at app.chain.link/cre/workflows.
- **Deploy access:** requested; approval arrives by email. **Until then:** simulation works, but deploys and API keys don't (an API key needs deploy access).
- **Registry: private (Chainlink-hosted)**, set per target with `deployment-registry: "private"` in each `workflow.yaml`.
  - Deploys are authorized by a CRE login or `CRE_API_KEY`. No linked wallet, no ETH, no deployer key.
  - The workflow owner is the **organization address**, so it stays the same across redeploys and teammates. The executor pins it (§4.13).
  - Trade-off: the list of deployed workflows lives in Chainlink's hosted registry, not the Ethereum `WorkflowRegistry`. Execution and DON signatures are unchanged.
  - Switching to the onchain registry is one line per target (`onchain:ethereum-mainnet`), but then needs a linked wallet (`cre account link-key`, permanent) and mainnet ETH.
- **Deploys: GitHub Actions** (`.github/workflows/cre-deploy.yml`, run manually), so any teammate with write access to the repo can deploy. It runs the tests, rejects a config with placeholders (`scripts/check-config.ts`), builds the WASM, then `cre workflow deploy <workflow> --target production-settings --yes --non-interactive`. Every push also runs `.github/workflows/cre-checks.yml` (tests, typechecks, WASM builds; no secrets).
  - Secret: `CRE_API_KEY` (CRE platform → Organization → APIs → **+ Organization API**), in the GitHub `production` environment.
  - Updates keep the workflow name; the workflow ID changes.
- **CRE secrets** (`openaiApiKey` in `secrets.yaml`, from env var `OPENAI_API_KEY`):
  - **Local simulation:** `packages/cre-workflows/.env` (gitignored). A 1Password reference (`op://vault/item/field`) works in place of the raw key.
  - **Deployed:** Vault DON, org-owned: `CRE_CLI_SECRETS_ORG_OWNED=true cre secrets create secrets.yaml --target production-settings --secrets-auth=browser`, so any member can rotate them. The workflow's `secretsOwner` config is `""` in simulation and the org ID in production. ❓ *Confirm with the sponsor.*
- **Project:** `packages/cre-workflows/` holds `project.yaml`, `secrets.yaml`, and the `mirror/` and `review/` workflows, each with a `workflow.yaml` and `config.{staging,production}.json`.
  - Targets: `staging-settings` (simulate) and `production-settings` (deploy).
  - No chain writes, so no forwarder or consumer contract. `project.yaml` keeps the `hyperliquid-mainnet` RPC only because targets need one.
  - Toolchain: CRE CLI v1.37, `@chainlink/cre-sdk` 1.23, **Bun ≥ 1.2.21** (older Bun fails simulation with a `wasm unreachable` trap at `subscribe`).
- **Local setup:**
  ```
  curl -sSL https://app.chain.link/cre/install.sh | bash
  cre login
  cd packages/cre-workflows
  bun install --cwd ./mirror && bun install --cwd ./review
  cre workflow simulate mirror --target staging-settings
  ```
  The mirror needs the snapshot service and executor running; `./scripts/e2e-mirror.sh` starts both, simulates and checks the result (`all` runs the failure scenarios too). Operations: `docs/cre/RUNBOOK.md`; merging with the review core: `docs/cre/INTEGRATION.md`.

## 5. Stack
| Layer | Choice |
|---|---|
| Language / repo | TypeScript. **pnpm monorepo:** `packages/{backend, cre-workflows, executor, dashboard, shared}`. No license yet. |
| Hyperliquid | [`@nktkas/hyperliquid`](https://github.com/nktkas/hyperliquid) in the backend and executor; raw HTTP inside CRE |
| Prices | Hyperliquid oracle/mark prices via the Info API (`metaAndAssetCtxs`). BTC history from `candleSnapshot`. No Chainlink Data Feeds. |
| Orchestration | Chainlink CRE (`@chainlink/cre-sdk`, `cre` CLI), DON access from the sponsor on-site. No onchain contract. Private registry; deploys from GitHub Actions with `CRE_API_KEY` (§4.14). |
| AI | Two LLMs (≥ 1 OpenAI), structured JSON |
| Storage / hosting | Supabase. Backend and executor on Railway (the leaderboard download is too slow for serverless; the executor needs one long-running process for nonces and run ordering). Dashboard on Vercel. |
| Secrets | Railway/Vercel env vars plus CRE secrets. `.env.example` only in the repo. Runbook: `docs/cre/RUNBOOK.md`. |
| Testing | Fixtures, then $10–20 mainnet runs before the freeze. No testnet. |
| Optional / unused | NOWNodes (HyperEVM RPC + an Info API copy) if it helps with rate limits; not a track. No AgentKit. |

## 6. Timeline (SGT)
Budget ~1 h of testing per 2 h of features. Integrate only tested modules.

| When | Milestone |
|---|---|
| **Before Tue 12:00** | Handoff notes (one member is away midday Tue): scaffold, Supabase schema, env vars, task split · CRE organization + deploy access request (§4.14) |
| Tue 12–16 | DON access · wallet + API wallet · move and swap HYPE · spikes: `portfolio`, $10 IOC order, CRE in simulation, LLM-in-CRE |
| Tue 16–24 | `ingest` + `score` · kind labeling · start saving snapshots |
| Wed 00–08 | `backtest` (4 windows, algo vs. model A vs. model B) · `review` workflow |
| Wed 08–15 | `positions` · `mirror` · executor + ledger · end-to-end tiny-size run |
| Wed 15–19 | Dashboard · paper books · **freeze the set** (hash into `mirror` config, redeploy) |
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
- **CRE API key / repo write access = trading authority:** either can deploy a workflow whose reports the executor trusts. Mitigated by keeping repo write access to the team, the `production` environment, and the executor's sanity bounds (frozen set, notional cap).
- **Deploy access not yet approved** → no deploys or API key until it is. Ask the sponsor on-site.

## 8. Open questions
- [ ] ❓ Which two models (≥ 1 OpenAI)
- [ ] ❓ Agent output format: weight grid, continuous weights, or ranking
- [ ] ❓ Maker share: a plus or an exclusion?
- [ ] ❓ Balanced multiplier `m` (from the backtest)
- [ ] ❓ How to read sources' lending positions for Conservative
- [ ] ❓ Per-tier type-B threshold N (production)
- [ ] ❓ Org-owned CRE secrets on the private registry: confirm with the sponsor
- [x] Mirror → executor report: **exposures** (§4.13); `rebalance-report.schema.json` (orders) is kept as a contract document only. Why: `docs/cre/INTEGRATION.md`
- [x] Live bucket: **Aggressive** (team decision 2026-10-06); enforced in the review core and the frozen-configuration checks
- [x] Freeze confirmation: `configurationHash` pinned in the mirror config, backend and executor; no HyperEVM contract
- [ ] ❓ Our account mode: **unified** is simplest (one USDC balance margins core and `xyz`); standard mode needs USDC moved into each dex. Equity is read the same way either way

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

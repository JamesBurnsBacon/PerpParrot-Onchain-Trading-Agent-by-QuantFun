# PerpParrot 🦜

> Copy the best Hyperliquid perps traders and vaults, picked by quant screens and an AI agent, mirrored every ten minutes.
>
> **TOKEN2049 Origins Hackathon** · Tracks: **AI x Crypto** · **NOWNodes Multichain Infrastructure Challenge** · Status: scoring, AI review, mirror runs and executor built; dry run live on Vercel (perpparrot.vercel.app)
>
> **Direction (2026-10-07): no Chainlink CRE.** We no longer depend on Chainlink approving us for real usage, and the
> product is simpler without it: **read Hyperliquid → process (score, frozen configuration, targets) → AI review →
> trades → record (Supabase, dashboard).** Everything runs on our own services (Vercel; AWS or more Vercel if a job
> outgrows a function). Earlier commits, issues and PRs that mention CRE, the DON, signed reports or `cre-workflows`
> describe the removed design.

**TL;DR**
- Score Hyperliquid addresses (traders, HyperCore vaults, ERC-4626 vaults) on risk-adjusted performance.
- An AI committee reviews source wallets; the roster admits approved wallets and activates the frozen copy configuration.
- Every 10 minutes the backend reads the sources' positions and turns them into target exposures; the executor trades toward them.
- An executor holds the **weighted, netted** copy of those positions in our own Hyperliquid account (5 HYPE ≈ $470).
- **Evidence boundary:** operational runs demonstrate the machinery. Multi-window backtests against BTC are an evaluation goal; the checked-in research does not establish predictive edge.

> **Documentation:** [current system, research and historical material](docs/README.md).
>
> **Where things are:** AI review: [architecture](docs/agents/ARCHITECTURE.md), [system prompts](docs/agents/SYSTEM_PROMPTS.md), [acceptance cases](docs/agents/EVALUATION.md), [JSON contracts](packages/shared/schemas), [integration guide](docs/agents/INTEGRATION.md); checks: `pnpm test`, `pnpm typecheck`. Mirror runs and executor: README §4.7–4.8, [runbook](docs/ops/RUNBOOK.md), [deploy](docs/ops/DEPLOY.md); checks: `bun test` per package, `./scripts/e2e-mirror.sh all`. Agents working in this repo: [AGENTS.md](AGENTS.md). **Live bucket: Aggressive** (§4.3).

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
4. **Live:** the run log (each run's snapshot hash and targets), fills, per-source PnL.

## 2. Terminology
| Term | Meaning |
|---|---|
| **Source wallet** | An address we copy: a trader, a HyperCore vault, or the HyperCore account behind an ERC-4626 vault. We copy 5–25 of them. |
| **Slice** | Our scaled copy of one source's position in one asset, kept in a **virtual ledger** per (source, asset). |
| **Position** | Our actual net holding per asset, i.e. the sum of its slices. **The bottleneck:** ≈ $470 and a $10 minimum order allow ~5–10 net positions. |
| **Bucket** | A risk tier: a source universe, weights, and a leverage policy. |

## 3. Architecture
```
 BACKEND (Vercel service)
 ┌──────────────────────────────┐
 │ leaderboard + vault list     │
 │ ingest → label → score       │
 │ backtest · paper books       │
 └──┬───────────────────────────┘
    │ finalists
    v
 AI REVIEW (backend pipeline; Vercel Cron selection + roster)
 ┌──────────────────────────────┐
 │ Role / Risk / Red-Team LLMs  │
 │ review → approved bench     │──> roster → frozen configuration (validated hash)
 └──────────────────────────────┘
 EVERY 10 MIN (Vercel Cron)
 ┌──────────────────────────────┐
 │ :x9 backend reads the frozen │
 │ sources' positions (HL)      │
 │ → snapshot → target exposures│
 └──┬───────────────────────────┘
    │ GET /targets/:runAt (service binding)
    v
 EXECUTOR (Vercel service, dry run; one long-running process for live)
 ┌──────────────────────────────┐
 │ check config hash + account  │
 │ target = exposure × equity   │──> Hyperliquid (our account)
 │ plan, sign w/ API wallet     │
 └──┬───────────────────────────┘
    │ runs, evidence, fills
    v
 Supabase  <── backend also writes here
    │
    v
 Dashboard (Next.js, Vercel service)
```

## 4. Components

### 4.1 Ingest (backend)

The [research screening v1 methodology](docs/ingest/RESEARCH_SCREENING_V1.md) documents the October 6 first-pass shortlist, exact return and selection rules, and two reproducible high-return examples. It describes a local research snapshot; formal Score eligibility remains separate.

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
- **Production schedule** (Vercel Cron, state in Supabase): a scan every 12 h (~14k accounts), a rate-limited refresh every 5 min, a qualified list of ~250, and 25 picked every 10 min (high-frequency traders left out). See [docs/ingest/PIPELINE.md](docs/ingest/PIPELINE.md).

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
- **Pure takers score slightly lower.** If under 5% of an account's perp volume in the last 30 days was maker fills,
  0.02 is taken off its score (❓ *both values tuned*). Accounts with unknown maker share are not penalized.
  - Why: in an out-of-sample test (2 × 200 accounts), a high maker share did not predict returns.
  - Near-zero maker accounts had about twice the drawdowns, mostly because they trade more of their equity.
  - Evidence: `scripts/research/maker-share/`.
- **Clone grouping before the cut:** accounts whose daily returns correlate ≥ 0.9 (❓ *tuned*), or that are known to be linked (vault ↔ leader, sub-accounts), are grouped and only the best-scoring one can be a finalist. Duplicates would concentrate the portfolio in one strategy's idiosyncratic risk.
- **Top ~25 distinct strategies → finalists**, with slots split between traders and vaults (❓ *split set in tuning*). Full definitions: `packages/backend/src/score/SPEC.md`.
- **Also computed** for the agent:
  - annualized return and volatility, all-time max drawdown (reported, not ranked)
  - realized volatility and average leverage
  - time in market and holding times
  - **maker/taker volume split**: maker notional / total perp notional, from `crossed` on fills. `userFees` daily
    volumes disagreed with fills on sampled accounts. The split also drives the pure-taker penalty above.

### 4.3 Buckets
| Bucket | Source universe | Exposure | Hackathon mode |
|---|---|---|---|
| **Aggressive** | Traders + vaults | Mirrored exactly, subject to the 95% margin rule (§4.8) | **Live** |
| **Balanced** | Same set as Aggressive | Aggressive's targets **× 0.5** | Paper |
| **Conservative** | Same set as Aggressive | Aggressive's targets **× 0.25** | Paper |

The buckets differ **only by that fixed multiplier** (owner, 2026-10-07): same wallets, same perps, same direction, same moments. The 5× gross cap applies to Aggressive's targets first, so Balanced tops out at 2.5× and Conservative at 1.25×. Each book's equity band scales with its multiplier; only the exchange's $10 minimum order stays fixed, so a smaller multiplier needs proportionally more capital to place the same legs.

### 4.4 Copy model
- **Slice:** `slice_i,c = wᵢ × sᵢ × (nᵢ,c / Eᵢ) × E_ours`.
  - `sᵢ = 2 ÷ max(Lᵢ, 0.05)` normalizes each wallet to **2× of its usual leverage** (owner, 2026-10-07), where `Lᵢ` is its 30-day average gross leverage (measured at review, kept on its roster seat, carried in each snapshot's `leverage`). A 0.1× vault and a 4× trader then count alike on a usual day; a wallet running above or below its own average (risk-on, de-risking, exiting) still moves our exposure. One wallet never counts past the 5× gross cap on its own; a wallet with no measured average is copied as it is (`sᵢ = 1`).
  - `nᵢ,c` is source *i*'s signed notional in asset `c`.
  - `Eᵢ` is the source's *current* equity, so its deposits and withdrawals don't distort our size.
- **A wallet's exit is a signal:** each source contributes at its frozen weight `wᵢ`; a flat source contributes nothing, so our exposure shrinks with its exit. (Weights used to be renormalized over the sources holding positions, which rescaled every other perp on each exit and failed runs when it pushed a source past its ceiling.) An exit is also the natural moment to replace that wallet (design in progress).
- **Position** in asset `c` = `Σᵢ slice_i,c`, netted at order time.
- **At most 15 positions** (owner, 2026-10-07: the book holds 5–15 perps): when the wallets' combined targets cover more perps, the 15 largest by |exposure| are kept and scaled up so the counted gross is unchanged (`limitPositions`); the rest go to 0, and their closes still wait 3 runs. Separately, the roster aims for **12–15 wallets** (at least 5).
- **Trade a leg only if** the gap is **≥ $10, ≥ 10%** of the target **and ≥ 0.5% of equity** (`shared/rebalance.ts`, the executor and the paper books alike).
- **Closes are confirmed:** a held perp whose target drops to 0 is closed only once its target has been 0 for **3 runs in a row** (~30 min; `shared/copy.ts` `pendingCloses`, served with `/targets`). Until then it is kept (`CLOSE_PENDING`). A perp whose market is no longer tradable, and a human flatten, close at once.
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

**Production** (25 sources picked **every 10 minutes** from a qualified list rebuilt every 12 h; a reviewed set whose wallets changed, or whose weights moved by more than 5 points, goes live automatically at the next `:x0` run: [docs/ingest/PIPELINE.md](docs/ingest/PIPELINE.md)):

| Type | Trigger | Handling |
|---|---|---|
| **A: edged out** | A better performer takes the spot | Recompute targets with the new mix. Legs misaligned with the new allocation become **reduce-only**, following the old source's reductions and closes so nothing is orphaned. After **24 h**, DCA out in **3 trades over 3 h**. |
| **B: performed badly** | The source's own drawdown from peak is ≥ N%, with **N set per tier** (❓ values) | **Immediate exit** of its slices on the next run |

### 4.6 AI layer: the review committee

The production pipeline invokes the Role/Risk/Red-Team committee through
`packages/backend/src/pipeline/index.ts`. Vercel Cron selects candidates at `:x4`;
reviews persist evidence, model output audit and an approved **bench** in
`selection_runs`. The `:x6` roster job admits eligible wallets into seats and activates
a validated frozen configuration when seats change. See
[PIPELINE.md](docs/ingest/PIPELINE.md), [ROSTER.md](docs/ingest/ROSTER.md) and the
[integration map](docs/agents/PRODUCTION_INTEGRATION.md).

- **Inputs:** Score finalists, month equity/PnL curves, current positions, measured
  fill/holding/leverage evidence and exposure overlap.
- **Models:** server-side `openAIPaperCommittee`, configured by `REVIEW_MODEL` and
  `OPENAI_API_KEY`. The provider adapter validates structured output; model prose
  does not authorize orders.
- **Approval:** the strict core's manifest and the default basic gate have different
  requirements (`REVIEW_GATE`). Approved picks populate the bench; roster admission
  and deterministic configuration checks control activation.
- **Execution:** mirror runs consume the frozen configuration and snapshot targets.
  They do not call a model while placing orders. Later reviews can affect future
  roster configurations through the same controlled pipeline.
- **Operator tools:** `backend/scripts/review-input.ts`, `review-run.ts` and `freeze.ts`
  remain available for explicit runs. They are not the production cron entrypoints.
- **Research boundary:** multi-model comparison and multi-window out-of-sample replay
  are evaluation work, not proven benefits of a working production loop.

### 4.7 Mirror runs (every 10 min, at :x0)
One run per 10-minute slot (`mirror-<runAt>`). Code: `packages/backend` (snapshot, targets), `packages/executor` (run), `packages/shared`.
1. **Read the sources** (backend): Vercel Cron calls `/api/backend/cron/snapshot` at `:x9`; the backend reads every frozen source's positions and equity from Hyperliquid and stores the run's **positions snapshot** (`packages/shared/snapshot.ts`, table `run_snapshots`), immutable once built. It is public at `GET /api/backend/snapshots/:runAt`.
   - Contents: the **frozen configuration** (below), the eligible-asset list, and per frozen source its equity and eligible positions (signed USD notional). Amounts are decimal strings × 1e6.
   - **Equity = HL's live account value** from the `portfolio` request (last point of the `day` window, live), not Σ per-dex `accountValue`. Most leaderboard traders use unified or portfolio-margin accounts (23 + 5 of 40 sampled), where per-dex `accountValue` is only the margin set aside on that dex; summing it understated equity, and so overstated leverage, by 2–10×. The portfolio value is also what the backtest's returns use.
   - The backend only builds real run times (`:x0`) within 120 s of now, so nobody can pre-build a stale snapshot for a future run through the public endpoint.
2. **Targets** (backend, `GET /api/backend/targets/:runAt`): `exposure_c = Σᵢ wᵢ · nᵢ,c / Eᵢ` per asset in bigint math (`targetsFromSnapshot`, `packages/shared/copy.ts`), with the snapshot's hash, configuration hash and account. The paper books step from the same snapshot.
   - Weights are the frozen `weightUnits`; cash stays cash, and a flat source's weight stays uninvested (its exit is followed). Each listed wallet is normalized to 2× of its 30-day average leverage (`snapshot.leverage`, §4.4). Exposure is capped at the policy's `maxGrossLeverage`, **5×** (owner, 2026-10-07), by scaling every perp down pro-rata. What counts against it: longs and shorts are each summed over perps, and the side in the minority counts at **half** (`majority + ½ × minority`, `countedGross`), since offsetting longs and shorts are partly hedged: 3× long BTC and 2× short ETH count 4×, while 5× long across perps counts 5×. Positions in the same perp net out first. One normalized wallet never counts past the cap on its own, measured the same way. Every source must be in the frozen configuration and hold only eligible assets.
3. **Execute** (executor): Vercel Cron calls `/api/executor/cron/run` at `:x0` (a long-running executor uses its own timer). The executor claims the run (a second trigger is a no-op), fetches the targets over the `BACKEND_URL` service binding, rejects them unless the configuration hash and account match its pinned `FROZEN_CONFIGURATION_HASH` and `HL_ACCOUNT`, then plans and trades (§4.8).
- **Frozen configuration = execution authority.** The review turns a VALID/LIVE review into a `FrozenConfiguration`: sources with integer weight and ceiling units, cash units, **our account**, the policy, and a `configurationHash` (keccak over canonical JSON, domain `perpparrot:frozen:v1`). `packages/shared/frozen.ts` checks it without dependencies.
- **Freeze commitment:** the `configurationHash` is pinned in both services' environment (`FROZEN_CONFIGURATION_HASH`); the backend refuses to build from another configuration and the executor refuses targets from one. **No onchain contract:** everything trades in our own HL account. Freezing = `packages/backend/scripts/freeze.ts --write` (saves `frozen/live.json`, prints the variables), set the variables, redeploy.
- **On failure** (Hyperliquid read, backend down, configuration mismatch, timeout): the run is recorded as failed, the executor holds positions, and the next run retries. The executor alerts on Telegram after 25 min without a finished run (≈ 2 missed runs).
- **Assets that lose eligibility:** the executor closes them (they're absent from the targets) rather than following sources' reductions (§4.4 reduce-only). Simpler, and HL allows reduce-only closes of any size; revisit if it costs too much.
- **Status (2026-10-07):** `scripts/e2e-mirror.sh all` passes five scenarios on live HL data with the fixture's frozen set (every HL account mode: 4 standard vaults, 2 unified and 1 portfolio-margin trader with HIP-3 positions): the happy path (targets, planned and signed in dry run, snapshot hash recorded), a paused executor, backend down, a mismatched configuration and a duplicate trigger. At full size (25 leaderboard traders, 201 positions) the snapshot is 12.8 KB.

### 4.8 Execute (executor service)
Code: `packages/executor`. A Bun service. Dry run deploys as the `executor` service of the Vercel project (root `vercel.json`, `/api/executor/*`). Live trading needs one long-running process (`Dockerfile` + `railway.json`) for one HL nonce sequence, an in-process run queue and no function timeout, so the executor refuses `DRY_RUN=false` on Vercel.
- **Runs** (`GET /cron/run` from Vercel Cron at `:x0`, a timer on a long-running host, or `POST /admin/run` for a given slot): claim the run (one per slot), fetch the backend's targets, check the configuration hash and our account, and trade until `runAt + RUN_TTL_SECONDS` (300 s). Runs are queued and never overlap, even across processes (a Postgres run lock); expiry is re-checked when a run starts. A run still going after 60 s is alerted on and cancelled before its next leverage update or order batch (batches already sent can't be recalled), and database queries time out after 10 s.
- **Plan** against the live account (`src/planner.ts`):
  - target = the run's exposure × our live equity (HL portfolio value) for every eligible asset; anything we hold that isn't targeted goes to 0
  - **margin rule:** if `Σ |N_c| / maxLev_c` would exceed **95% of equity**, scale **all** targets down pro-rata
  - **drift rule:** trade a leg only if the gap is ≥ $10 and ≥ 10% of the target; full closes are always allowed (reduce-only)
  - reductions first; reduce-only whenever an order only shrinks a position
  - **sanity bound:** reject a run's targets if their gross exposure (Σ |target notional| ÷ our equity) is over 10× (`MAX_GROSS_LEVERAGE`). Under the policy's 5× cap (minority side at half) raw gross can reach at most 6.67× (equal longs and shorts), so this only trips on a corrupted or misconfigured target; the run fails and the positions are held.
  - **own eligibility check:** never open, add to or flip a position in a market that isn't cross-margin with ≥ $15M OI by the executor's own reading, whatever the snapshot's list says (reductions still follow the sources)
  - the $10 minimum is checked at the IOC limit price
- **Orders:** IOC limit at mark ± 50 bps, prices and sizes rounded to HL tick/lot rules, ≤ 20 orders per action, a deterministic `cloid` per run and asset. Remainders are retried on the next run.
- **Leverage:** cross margin; each asset at its **max leverage** (`updateLeverage`, once per asset; many HIP-3 markets are 10x, BTC up to 40x). If HL refuses for one asset, only that asset's order is skipped.
- **Dry run by default:** orders are built and signed through `@nktkas/hyperliquid` exactly as they'd be sent, then recorded instead of POSTed. `DRY_RUN=false` plus `HL_API_WALLET_KEY` goes live.
- **Keys:** a fresh EOA. A human holds the master key; the executor holds only an **HL API wallet** key (trade, no withdraw).
- **Kill switch:** manual, bearer-token admin routes (any team member with `ADMIN_TOKEN`; the dashboard calls them behind auth).
  - **Pause / resume:** stop or restart trading, keep positions.
  - **Flatten:** pause, then close everything reduce-only, whatever the targets say.
- **Durable recovery:** run claims, runs, controls, and each exchange action's write-ahead intent/results are stored in Supabase. Before dispatch the executor journals the exact order batch and deterministic client IDs; an unknown response, or a restart with an unresolved batch, is **reconciled automatically** by the next run (`packages/executor/src/reconcile.ts`). Every action is signed with `expiresAfter` (the run's expiry), so once that has passed it either landed or never will. The run looks up each client order ID with Hyperliquid's `orderStatus` (leverage with `activeAssetData`), records that as the evidence, and trades against the live account. Before expiry, a batch closes only if every order is already final; otherwise only its perps are left alone for that run (`IN_FLIGHT`) and everything else trades. **No bot pauses trading**: only a human pauses (`/admin/pause`) or flattens. `GET /admin/order-batches` and `POST /admin/reconcile-batch` remain for manual inspection. Never retry an ambiguous order blindly: the next run re-plans from the account. Apply `20261006180000_executor_order_journal.sql` before enabling the journaled executor.
- **Run log:** `GET /runs` (plans, order results, evidence: snapshot hash, configuration, targets), `GET /runs?summary=1`, `GET /equity` and `GET /status`; retained in Supabase when `DATABASE_URL` is set. Vercel dry-run mode requires Supabase and `CRON_SECRET`; live trading remains restricted to one long-running executor.
- **Alerts:** Telegram bot (`TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`) for failed runs, failed orders and missed runs.
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

Status: built (`packages/backend/src/paper/`), stepped from every run's snapshot and served at `GET /paper`. Running now: Aggressive, Balanced (× 0.5, `PAPER_BALANCED_MULTIPLIER`) and Conservative (× 0.25, `PAPER_CONSERVATIVE_MULTIPLIER`), each at $470 (live size) and as a $10k twin, and BTC buy & hold. Books hold on runs whose targets the executor would get none for, and pay funding between runs at HL's current hourly rate. The shadow model waits for the review core; adding a book is a `BookSpec` in `defaultBooks`.
- **Books:** Balanced, Conservative, the shadow model, and a $10k twin of live Aggressive.
- **Sizes:** each at **~$470 and $10k**, to show the strategy both with and without the minimum-order effect.
- **Fills:** at HL mark price, plus the taker fee, plus the backtest slippage, with the $10 minimum applied.

### 4.11 Dashboard (Next.js + Tailwind on Vercel): public, read-only

Status: built (`packages/dashboard`): live account vs paper books vs BTC, targets vs held with the executor's action per asset (last run), heartbeat and run log (each run's snapshot hash and targets, downloadable), backtest vs BTC, funnel and finalists. Backtest, funnel and finalists render once their jobs publish to `dashboard_artifacts` (contract: `packages/shared/dashboard.ts`, RUNBOOK § Data for the dashboard). Not yet: per-source PnL, admin actions (Pause/Flatten stay on the executor's authenticated API).
- **Landing:** the backtest vs. BTC (algo-only, model A, model B).
- **Also:**
  - the funnel
  - finalist drill-down
  - buckets and paper books
  - live positions vs. targets
  - per-source PnL
  - the run log with each run's snapshot hash and targets, so anyone can check them
- The Pause/Flatten admin actions sit behind auth.

### 4.12 Module contracts
| Module | Input | Output |
|---|---|---|
| `ingest` | leaderboard, vault list, HL Info API, HyperEVM RPC | `snapshots` |
| `score` | `snapshots` | `candidates` (filters, metrics, score) |
| `backtest` | `snapshots`, `candidates`, agent picks | `backtests` per OOS window |
| `review` | finalists | `reviews`, `buckets`, freeze hash |
| `positions` | source set | positions snapshot, target exposures |
| `execute` | targets | `orders`, `fills`, `ledger`, run evidence |
| `paper` | snapshot, buckets, mark prices | `paper_books` |
| `dashboard` | all tables | — |

### 4.13 Run record and how to check it
- **Exposures, not orders or USD targets.** Exposure = target notional as a fraction of our equity. The executor multiplies by our live equity and diffs against the live account when it runs, so price and equity moves between the read and execution don't matter.
- **Evidence per run** (`executor_runs.evidence`, `GET /api/executor/runs`): the snapshot hash (keccak256 of the snapshot JSON), the configuration hash and the targets. Anyone can fetch `GET /api/backend/snapshots/:runAt`, hash it, and recompute the targets with `targetsFromSnapshot`.
- `packages/shared/schemas/rebalance-report.schema.json` is a review-core contract fixture, not a runtime transport.

### 4.14 Hosting and scheduling
- **One Vercel project, three services** (root `vercel.json`): dashboard at `/`, backend at `/api/backend/*`, executor at `/api/executor/*`. The executor reaches the backend over a service binding (`BACKEND_URL`). Supabase Postgres holds all state. Deploy and operations: [docs/ops/DEPLOY.md](docs/ops/DEPLOY.md), [docs/ops/RUNBOOK.md](docs/ops/RUNBOOK.md).
- **Vercel Cron** (production deployments only): `:x9` snapshot pre-build, every 5 min the missed-run watchdog, and the selection pipeline. The `:x0` run is triggered by the long-running executor itself (Railway). Cron routes require `CRON_SECRET`.
- **Live trading** needs one long-running executor process (one HL nonce sequence, no function timeout): the `Dockerfile` + `railway.json` build it; it triggers its own runs at `:x0`. The executor refuses `DRY_RUN=false` on Vercel.
- **Ingest, scoring and scheduled AI reviews**: Vercel Cron as well (decided 2026-10-07; [docs/ingest/PIPELINE.md](docs/ingest/PIPELINE.md)). If Hyperliquid rate-limits Vercel's IPs, only the refresh job moves to one long-running process (Railway, same code).
- **CI:** `.github/workflows/service-checks.yml` (backend and executor against Postgres, dashboard build) and `.github/workflows/agent-review-checks.yaml` (AI review core). No secrets in CI.

## 5. Stack
| Layer | Choice |
|---|---|
| Language / repo | TypeScript. `packages/{backend, executor, dashboard, shared}`: Bun per service package, pnpm (Node 24) for the review core and root tests. No license yet. |
| Hyperliquid | [`@nktkas/hyperliquid`](https://github.com/nktkas/hyperliquid) in the executor (signing); the Info API over plain HTTP for reads |
| Prices | Hyperliquid oracle/mark prices via the Info API (`metaAndAssetCtxs`). BTC history from `candleSnapshot`. |
| Orchestration | Vercel Cron and our own services (§4.14). No onchain contract. |
| AI | Two LLMs (≥ 1 OpenAI), structured JSON |
| Storage / hosting | Supabase. One Vercel project with three services (root `vercel.json`): dashboard at `/`, backend at `/api/backend`, executor at `/api/executor`, Vercel Cron for the snapshot pre-build, the run and the missed-run watchdog. Live trading moves the executor to one long-running process (nonces and run ordering; `Dockerfile` + `railway.json`); the leaderboard download, once built, may need one too (too slow for a function). |
| Secrets | Vercel env vars. `.env.example` only in the repo. Runbook: `docs/ops/RUNBOOK.md`. |
| Testing | Fixtures, then $10–20 mainnet runs before the freeze. No testnet. |
| NOWNodes challenge | NOWNodes (HyperEVM RPC + an Info API copy), our entry in its Multichain Infrastructure Challenge: a failover for the backend's Hyperliquid info reads and the first choice for the overlap guard's position reads. Both are opt-in and off by default; see "NOWNodes" below. |
| Unused | No AgentKit. |

## 6. Timeline (SGT)
Budget ~1 h of testing per 2 h of features. Integrate only tested modules.

| When | Milestone |
|---|---|
| **Before Tue 12:00** | Handoff notes (one member is away midday Tue): scaffold, Supabase schema, env vars, task split |
| Tue 12–16 | wallet + API wallet · move and swap HYPE · spikes: `portfolio`, $10 IOC order, LLM review |
| Tue 16–24 | `ingest` + `score` · kind labeling · start saving snapshots |
| Wed 00–08 | `backtest` (4 windows, algo vs. model A vs. model B) · `review` workflow |
| Wed 08–15 | `positions` · `mirror` · executor + ledger · end-to-end tiny-size run |
| Wed 15–19 | Dashboard · paper books · **freeze the set** (hash into both services' environment, redeploy) |
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
- **Duplicate orders** → one claim per run slot, deterministic `cloid`s, HL nonces.
- **Repo write access / Vercel project access = trading authority:** either can deploy code the executor runs. Mitigated by keeping both to the team, the pinned configuration hash, and the executor's sanity bounds (frozen set, gross leverage cap).

## 8. Open questions
- [ ] ❓ Which two models (≥ 1 OpenAI)
- [ ] ❓ Agent output format: weight grid, continuous weights, or ranking
- [x] Maker share: **neither**. Zero or near-zero maker volume (< 5%) is a slight score penalty (§4.2); a high share earns nothing. Evidence: `scripts/research/maker-share/`
- [ ] ❓ Per-tier type-B threshold N (production)
- [x] Backend → executor: **exposures** (§4.13); `rebalance-report.schema.json` (orders) is kept as a contract document only
- [x] Live bucket: **Aggressive** (team decision 2026-10-06); enforced in the review core and the frozen-configuration checks
- [x] Freeze confirmation: `configurationHash` pinned in the backend and executor environment; no HyperEVM contract. With automatic go-live it moves to an `active` row in Supabase ([docs/ingest/PIPELINE.md](docs/ingest/PIPELINE.md))
- [x] Orchestration: **no Chainlink CRE** (2026-10-07); Vercel Cron and our own services, AWS if a job outgrows a function
- [x] Scheduled AI reviews and the ingest: **Vercel Cron**, 12-hour scans, 25 picked every 10 minutes, automatic go-live ([docs/ingest/PIPELINE.md](docs/ingest/PIPELINE.md))
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

### NOWNodes (our Multichain Infrastructure Challenge entry)
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
- In the recorded benchmark, NOWNodes was about 1.7x slower per read (median 0.36 s vs 0.21 s). Routing is configurable: `official` is the default, `overflow` retries supported failed reads, and `split` with `INFO_SPLIT_PERCENT=100` makes supported reads NOWNodes-first with official fallback. Check deployed settings and `/pipeline` metrics; see `docs/ops/DEPLOY.md`.
- Paid plans advertise unlimited requests per second. It needs an API key. [Docs](https://docs.nownodes.io/hype)

### Coinbase AgentKit
- No Hyperliquid action provider. Its TS providers include `vaultsfyi`, `morpho`, `defillama`, `across`, `erc20`, `x402`. Not used.

### References
- HL: [info endpoint](https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/info-endpoint) · [rate limits](https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/rate-limits-and-user-limits) · [nonces & API wallets](https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/nonces-and-api-wallets) · [vaults](https://hyperliquid.gitbook.io/hyperliquid-docs/hypercore/vaults) · [portfolio margin](https://hyperliquid.gitbook.io/hyperliquid-docs/trading/portfolio-margin)
- Data: [HL leaderboard](https://app.hyperliquid.xyz/leaderboard) · [hyperliquidvaults.com](https://hyperliquidvaults.com) · [HyperTracker](https://hypertracker.io) · [DefiLlama yields](https://yields.llama.fi/pools) · [tradingstrategy.ai ERC-4626 list](https://web3-ethereum-defi.tradingstrategy.ai/tutorials/erc-4626-vault-list)
- SDKs: [`@nktkas/hyperliquid`](https://github.com/nktkas/hyperliquid) · [Coinbase AgentKit](https://github.com/coinbase/agentkit)

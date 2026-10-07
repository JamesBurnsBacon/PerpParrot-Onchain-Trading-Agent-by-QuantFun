// The selection pipeline (docs/ingest/PIPELINE.md), run by the backend's cron routes:
//   scan:    every leaderboard trader and HyperCore vault with ≥ $10k (~14k; every 12 h)
//   refresh: portfolios of the scan within 12 h; portfolio + fills of the qualified list hourly
//            (every 5 min, within a weight budget)
//   select:  every 10 min: Score qualifies ~250 once the scan is refreshed, picks 25 from them
//            (high-frequency traders left out) → AI review (Role, Risk, Red-Team) when the 25
//            change → the bench: the wallets the AI approves, with their hold measures
//   roster:  every 10 min (docs/ingest/ROSTER.md): seats with a minimum tenure, released at exits,
//            filled from the bench → freeze → activate when the seats change
// The active configuration is what the 10-minute mirror loop copies from its next run on.
import type { SQL } from "bun";
import { FILLS_PAGE, fillStats, isHighFrequency, pickLeaderboard, sameAddresses, scoringWindows, type Fill, type LeaderboardRow, type Tracked } from "./derive";
import { EVIDENCE_DAYS, holdMeasures, measure, type HlFill, type HoldMeasures, type Measured } from "./evidence";
import {
  ACTIVE, capsFrom, impliedTurnover, lossBreached, observe, passesHoldGate, planAdmissions, pnlAndEquity, reviewSeat, ROSTER, SEAT_REVIEW_HOURS,
  targetSeats, transition, type BenchEntry, type Seat, type SnapshotEntry, type Transition, type Verdict,
} from "./roster";
import { ENTER_OI_USD, fetchOpenInterest } from "../eligibility";
import { PacedInfo, getJson } from "./hl";
import { routingStats } from "./info-router";
import { verificationStats } from "../snapshot-verify";
import { checkContracts, nownodesCode, type CodeReader } from "./contract-check";
import { overlapGuard, readPositionsBulk, type GuardSummary, type PositionReader } from "./overlap-pick";
import { pickVaults } from "./vaults";
import { parsePortfolio, scoreCandidates, toFrameCandidates, type ScoreInput, type ScoreResult } from "../score";
import { buildReviewInput, positionsFromStates, type LivePosition } from "../../review/input.ts";
import { exposureOverlap, summarizeOverlap } from "../../review/overlap.ts";
import { openAIPaperCommittee } from "../../review/models/openai-paper.ts";
import { runCommitteeReview } from "../../review/committee/workflow.ts";
import { MAX_SOURCES, type Assessment } from "../../review/workflow.ts";
import { commitment, policyCommitment } from "../../../shared/src/commitments.ts";
import { validate } from "../../../shared/src/validate.ts";
import type { Policy, Row } from "../../../shared/src/contracts.ts";
import { checkFrozenConfiguration, type FrozenConfiguration } from "../../../shared/frozen";
import { ELIGIBLE_DEXES, type PositionsSnapshot, type WindDownSource } from "../../../shared/snapshot";
import { keccakUtf8 } from "../snapshot";

const HOUR = 3_600_000;
// The live policy's cap on gross exposure, Σ |target| ÷ equity (owner, 2026-10-07). Applied to the
// targets before any bucket multiplier, so Balanced (× 0.5) tops out at 2.5× and Conservative (× 0.25) at 1.25×.
export const MAX_GROSS_LEVERAGE = 5;
const LEADERBOARD = "https://stats-data.hyperliquid.xyz/Mainnet/leaderboard";
const QUALIFIED = 250; // Score's top distinct accounts over the scan
const PICKS = 25; // picked every 10 minutes from the qualified list, and reviewed
const GUARD_POOL = 60; // candidates whose books the overlap guard reads (PICK_OVERLAP_GUARD=on)
const CLAIMS = 200; // accounts one refresh claims; unprocessed ones are released
const WORKERS = 3; // concurrent Hyperliquid reads in one refresh, sharing its weight budget
// Qualifying waits for 95% of the scan, or this long after it with what is fresh (cold start).
const QUALIFY_AFTER = 3.5 * HOUR;

export type PipelineOptions = {
  sql: SQL;
  account: string; // HL_ACCOUNT: the configuration is frozen for it
  policy: Policy; // the bucket policy reviews run under (the fixture's Aggressive LIVE policy)
  openAiKey?: string;
  model?: string;
  log: (msg: string, data?: Record<string, unknown>) => void;
  now?: () => number;
  info?: (perMinute: number) => PacedInfo; // Hyperliquid info client (tests)
  // PICK_OVERLAP_GUARD=on (and NOWNODES_API_KEY): prefer picks whose books do not overlap (overlap-pick.ts).
  overlapGuard?: boolean;
  positions?: PositionReader; // book reader for the guard (tests)
  // CONTRACT_CHECK=on (and NOWNODES_API_KEY): record which picks are contracts on HyperEVM (contract-check.ts). Evidence only.
  contractCode?: CodeReader;
  picks?: number; // how many accounts a pick keeps (default PICKS; tests)
  // "strict": only the review core's VALID manifest activates. "basic" (default): when the core
  // rejects for missing measured evidence, keep the finalists the AI rated acceptable (below).
  gate?: "strict" | "basic";
};

type AccountRow = {
  address: string;
  kind: "trader" | "hypercore-vault";
  account_value: number;
  closed: boolean | null;
  portfolio: unknown;
  trade_count: number | null;
  maker_share: number | null;
  orders_per_day: number | null;
};

const toInput = (r: AccountRow): ScoreInput => ({
  address: r.address,
  kind: r.kind,
  accountValue: r.account_value,
  closed: r.closed,
  ...parsePortfolio(r.portfolio),
  history: null,
  tradeCount: r.trade_count,
  makerShare: r.maker_share,
});

export class Pipeline {
  private readonly now: () => number;
  private readonly info: (perMinute: number) => PacedInfo;

  constructor(private readonly o: PipelineOptions) {
    this.now = o.now ?? Date.now;
    this.info = o.info ?? ((perMinute) => new PacedInfo(perMinute));
  }

  async scan(): Promise<{ leaderboard: number; vaults: number }> {
    const { sql, log } = this.o;
    const vaults = await pickVaults(this.now(), log);
    const board = await getJson<{ leaderboardRows: LeaderboardRow[] }>(LEADERBOARD);
    const traders = pickLeaderboard(board.leaderboardRows, Infinity, new Set(vaults.map((v) => v.address)));
    const listedAt = new Date(this.now());
    // One row per address: an upsert can't touch the same row twice.
    const rows = [...new Map(([...vaults, ...traders] as Tracked[]).map((t) => [t.address, t])).values()].map((t) => ({
      address: t.address, source: t.source, kind: t.kind, name: t.name, account_value: t.accountValue, closed: t.closed, listed_at: listedAt.toISOString(),
      primary_source: t.primary,
    }));
    for (let i = 0; i < rows.length; i += 1000) {
      await sql`
        insert into pipeline_accounts ${sql(rows.slice(i, i + 1000))}
        on conflict (address) do update set source = excluded.source, kind = excluded.kind, name = excluded.name,
          account_value = excluded.account_value, closed = excluded.closed, listed_at = excluded.listed_at,
          primary_source = excluded.primary_source`;
    }
    log("pipeline scanned", { leaderboard: traders.length, vaults: vaults.length });
    return { leaderboard: traders.length, vaults: vaults.length };
  }

  // Refreshes until `deadlineMs`, three reads at a time: first the qualified accounts whose fills
  // are an hour old (portfolio + fills), then the scan's accounts not refreshed for 11 h
  // (portfolio only), primary sources first, then the largest accounts (account value or TVL), so a
  // qualified list built before the scan is fully refreshed leaves out the smallest. Scans first
  // when the latest scan is over 12 h old.
  async refresh(deadlineMs: number): Promise<{ scanned: boolean; refreshed: number; failed: number }> {
    const { sql, log } = this.o;
    const [{ listed }] = await sql`select max(listed_at) as listed from pipeline_accounts`;
    let scanned = false;
    if (!listed || this.now() - (listed as Date).getTime() > 12.5 * HOUR) {
      await this.scan();
      scanned = true;
    }
    // Claimed rows are skipped by a concurrent invocation for 10 minutes, or until released.
    const claimed = (await sql`
      update pipeline_accounts set attempted_at = now()
      where address in (
        select address from pipeline_accounts
        where (attempted_at is null or attempted_at < now() - interval '10 minutes')
          and ((qualified_at is not null and (fills_at is null or fills_at < now() - interval '1 hour'))
            or (listed_at >= (select max(listed_at) from pipeline_accounts) - interval '10 minutes'
              and (refreshed_at is null or refreshed_at < now() - interval '11 hours')))
        order by qualified_at is null, not primary_source, refreshed_at nulls first, account_value desc limit ${CLAIMS} for update skip locked)
      returning address, qualified_at is not null as qualified, primary_source, refreshed_at, account_value`) as { address: string; qualified: boolean; primary_source: boolean; refreshed_at: Date | null; account_value: number }[];
    claimed.sort((a, b) => Number(b.qualified) - Number(a.qualified) || Number(b.primary_source) - Number(a.primary_source) || (a.refreshed_at?.getTime() ?? 0) - (b.refreshed_at?.getTime() ?? 0) || b.account_value - a.account_value);
    const hl = this.info(900);
    let refreshed = 0;
    let failed = 0;
    let next = 0;
    // Workers take the next claimed account until the claims or the time run out.
    const work = async () => {
      while (next < claimed.length && this.now() <= deadlineMs - 10_000) {
        const { address, qualified } = claimed[next++];
        try {
          const portfolio = scoringWindows(await hl.post<unknown>({ type: "portfolio", user: address }));
          parsePortfolio(portfolio); // reject a malformed response now, not at selection
          if (qualified) {
            const fills = await hl.post<Fill[]>(
              { type: "userFillsByTime", user: address, startTime: this.now() - 30 * 24 * HOUR, aggregateByTime: true },
              20,
              (f) => f.length,
            );
            const { tradeCount, makerShare, ordersPerDay } = fillStats(fills, this.now());
            await sql`
              update pipeline_accounts set portfolio = ${JSON.stringify(portfolio)}::text::jsonb, trade_count = ${tradeCount}, maker_share = ${makerShare},
                orders_per_day = ${ordersPerDay}, refreshed_at = now(), fills_at = now(), attempted_at = null, error = null
              where address = ${address}`;
          } else {
            await sql`update pipeline_accounts set portfolio = ${JSON.stringify(portfolio)}::text::jsonb, refreshed_at = now(), attempted_at = null, error = null where address = ${address}`;
          }
          refreshed++;
        } catch (e) {
          failed++;
          await sql`update pipeline_accounts set error = ${(e as Error).message} where address = ${address}`;
        }
      }
    };
    await Promise.all(Array.from({ length: WORKERS }, work));
    const unprocessed = claimed.slice(next).map((c) => c.address);
    if (unprocessed.length) await sql`update pipeline_accounts set attempted_at = null where address in ${sql(unprocessed)}`;
    log("pipeline refreshed", { scanned, claimed: claimed.length, refreshed, failed, released: unprocessed.length });
    return { scanned, refreshed, failed };
  }

  async status() {
    const { sql } = this.o;
    const [counts] = await sql`
      select count(*) filter (where listed_at >= (select max(listed_at) from pipeline_accounts) - interval '10 minutes')::int as listed,
        count(*) filter (where listed_at >= (select max(listed_at) from pipeline_accounts) - interval '10 minutes'
          and refreshed_at > now() - interval '12 hours')::int as fresh,
        count(*) filter (where error is not null)::int as errors,
        count(*) filter (where qualified_at is not null)::int as qualified,
        count(*) filter (where qualified_at is not null and orders_per_day > 100)::int as high_frequency,
        max(qualified_at) as qualified_at,
        max(listed_at) as listed_at
      from pipeline_accounts`;
    const runs = await sql`
      select id, started_at, finished_at, status, accounts, configuration_hash, error, review -> 'manifest' as manifest
      from selection_runs order by started_at desc limit 10`;
    const [active] = await sql`select hash, activated_at, configuration -> 'sources' as sources from configurations where status = 'active'`;
    // The latest run's finalists, funnel and per-candidate AI verdicts (dashboard).
    // The latest review of Score's picks (not a seat review), with its bench of approvals.
    const [latest] = await sql`select id, finalists, review -> 'summary' as summary, review -> 'bench' as bench from selection_runs
      where (finalists ->> 'scope') is distinct from 'seats' order by started_at desc limit 1`;
    return { accounts: counts, selections: runs, active: active ?? null, latest: latest ?? null, roster: await this.rosterStatus(), routing: routingStats(), verification: verificationStats() };
  }

  // Every 10 minutes: qualify when due, then pick 25 and review them if they changed. `force`
  // (operator) qualifies on partial data and reviews an unchanged pick.
  async select(force = false): Promise<{ id?: number; status: string; reason?: string }> {
    const { sql, log } = this.o;
    // A run killed mid-way (function timeout) would stay 'running' forever.
    await sql`update selection_runs set status = 'failed', error = 'did not finish', finished_at = now()
      where status = 'running' and started_at < now() - interval '20 minutes'`;
    const qualified = await this.qualify(force);
    if (qualified) log("pipeline qualified", qualified);

    const rows = (await sql`
      select address, kind, account_value, closed, portfolio, trade_count, maker_share, orders_per_day, fills_at
      from pipeline_accounts where qualified_at is not null`) as (AccountRow & { fills_at: Date | null })[];
    if (rows.length === 0) return { status: "waiting", reason: "no qualified list yet" };
    const ready = rows.filter((r) => r.portfolio !== null && r.fills_at !== null && this.now() - r.fills_at.getTime() < 2 * HOUR);
    if (!force && ready.length / rows.length < 0.9) return { status: "waiting", reason: `${ready.length}/${rows.length} qualified accounts have fresh fills` };
    const highFrequency = ready.filter((r) => isHighFrequency(r.orders_per_day)).length;
    const inputs = ready.filter((r) => !isHighFrequency(r.orders_per_day)).map(toInput);
    let result = scoreCandidates(inputs, { finalists: this.o.picks ?? PICKS });
    const guard = await this.guarded(inputs, result);
    if (guard) result = guard.result;

    // The AI review runs when the 25 change, and at least every 12 h so the roster's bench of approvals
    // stays fresh (ROSTER.md §4.1). A rejected set isn't reviewed again within that time.
    const [last] = await sql`select finalists -> 'finalists' as finalists, started_at, status from selection_runs
      where status <> 'failed' and finalists is not null and (finalists ->> 'scope') is distinct from 'seats' order by started_at desc limit 1`;
    const lastPicks = ((last?.finalists ?? []) as { address: string }[]).map((f) => f.address);
    // Only a review that produced a bench (or rejected the 25) counts: one from before the roster has none.
    const fresh = last && (last.status === "benched" || last.status === "rejected") &&
      this.now() - new Date(last.started_at as string | Date).getTime() < ROSTER.approvalFreshHours * HOUR;
    if (!force && fresh && sameAddresses(lastPicks, result.finalists)) return { status: "unchanged" };
    // One review at a time, and a failed one is retried after 30 minutes.
    // (A failed seat review doesn't hold the picks up.)
    const [busy] = await sql`select status from selection_runs
      where status = 'running' or (status = 'failed' and started_at > now() - interval '30 minutes' and (finalists ->> 'scope') is distinct from 'seats') limit 1`;
    if (busy && (busy.status === "running" || !force)) return { status: "waiting", reason: busy.status === "running" ? "a review is running" : "a review failed in the last 30 minutes" };

    const [{ id }] = await sql`insert into selection_runs (started_at, status, accounts) values (${new Date(this.now()).toISOString()}, 'running', ${inputs.length}) returning id`;
    try {
      const outcome = await this.review(id as number, inputs, result, highFrequency, guard?.summary);
      return { id, ...outcome };
    } catch (e) {
      log("selection failed", { id, error: (e as Error).message });
      await sql`update selection_runs set status = 'failed', error = ${(e as Error).message}, finished_at = now() where id = ${id}`;
      return { id, status: "failed", reason: (e as Error).message };
    }
  }

  // The overlap guard (opt-in): the top GUARD_POOL candidates' books are read NOWNodes first and the pick
  // prefers candidates that don't overlap one already chosen. Any failure leaves Score's own pick.
  private async guarded(inputs: ScoreInput[], base: ScoreResult): Promise<{ result: ScoreResult; summary: GuardSummary } | undefined> {
    const { log, policy } = this.o;
    const on = this.o.overlapGuard ?? (process.env.PICK_OVERLAP_GUARD === "on" && !!process.env.NOWNODES_API_KEY);
    const threshold = policy?.maxExposureOverlap;
    if (!on || typeof threshold !== "number" || !Number.isFinite(threshold)) return undefined;
    try {
      const pool = scoreCandidates(inputs, { finalists: GUARD_POOL });
      const g = await overlapGuard({ ranked: pool.finalists, want: this.o.picks ?? PICKS, threshold, read: this.o.positions ?? readPositionsBulk, now: this.now });
      if (!g) {
        log("overlap guard skipped", { reason: "a read failed or NOWNodes paused" });
        return undefined;
      }
      const dropped = new Set(g.excluded);
      const result = dropped.size ? scoreCandidates(inputs.filter((i) => !dropped.has(i.address)), { finalists: this.o.picks ?? PICKS }) : base;
      log("overlap guard", { ...g.summary, changed: !sameAddresses(base.finalists, result.finalists) });
      return { result, summary: g.summary };
    } catch (e) {
      log("overlap guard failed", { error: String((e as Error)?.message ?? e) });
      return undefined;
    }
  }

  // The qualified list: Score's top 250 distinct accounts over the latest scan, once the list is
  // older than that scan, every primary source is refreshed within 12 h, and either ≥ 95% of the
  // scan is or the scan is 3.5 h old (then over the accounts refreshed so far). Accounts never
  // qualified have no fills yet, so the trade count may be unknown here; the pick requires it.
  private async qualify(force: boolean): Promise<{ accounts: number; qualified: number } | undefined> {
    const { sql } = this.o;
    const [{ listed, qualified }] = await sql`select max(listed_at) as listed, max(qualified_at) as qualified from pipeline_accounts`;
    if (!listed || (qualified && (qualified as Date) >= (listed as Date))) return undefined;
    const rows = (await sql`
      select address, kind, account_value, closed, portfolio, trade_count, maker_share, orders_per_day, refreshed_at, primary_source, error
      from pipeline_accounts where listed_at >= ${(listed as Date).toISOString()}::timestamptz - interval '10 minutes'`) as (AccountRow & { refreshed_at: Date | null; primary_source: boolean; error: string | null })[];
    const isFresh = (r: (typeof rows)[number]) => r.portfolio !== null && r.refreshed_at !== null && this.now() - r.refreshed_at.getTime() < 12 * HOUR;
    const fresh = rows.filter(isFresh);
    // A primary source whose last read failed doesn't hold the list up.
    const primariesFresh = rows.every((r) => !r.primary_source || isFresh(r) || r.error !== null);
    const ready = fresh.length / rows.length >= 0.95 || this.now() - (listed as Date).getTime() >= QUALIFY_AFTER;
    if (fresh.length === 0 || (!force && !(primariesFresh && ready))) return undefined;
    const result = scoreCandidates(fresh.map(toInput), { finalists: QUALIFIED, allowUnknown: ["minTrades"] });
    await sql.begin(async (tx) => {
      await tx`update pipeline_accounts set qualified_at = null where qualified_at is not null`;
      if (result.finalists.length) await tx`update pipeline_accounts set qualified_at = now() where address in ${tx(result.finalists)}`;
    });
    return { accounts: fresh.length, qualified: result.finalists.length };
  }

  // `scope`: "picks" reviews Score's 25 and fills the bench; "seats" is the roster's 12-hourly
  // review of the wallets holding seats (its verdicts; never the admission bench).
  private async review(id: number, inputs: ScoreInput[], result: ScoreResult, highFrequency: number, guard?: GuardSummary, scope: "picks" | "seats" = "picks"): Promise<{ status: string; reason?: string }> {
    const { sql, log, policy } = this.o;
    const score = toFrameCandidates(result);
    const byAddress = new Map(result.candidates.map((c) => [c.address, c]));
    const finalists = result.finalists.map((address) => ({ address, kind: byAddress.get(address)?.kind, score: byAddress.get(address)?.score, rank: byAddress.get(address)?.rank }));
    const funnel = result.funnel;
    await sql`update selection_runs set finalists = ${JSON.stringify({ finalists, funnel, highFrequency, ...(guard ? { overlapGuard: guard } : {}), ...(scope === "seats" ? { scope } : {}) })}::text::jsonb where id = ${id}`;
    if (score.candidates.length === 0) throw new Error(`no frame candidates (${result.finalists.length} finalists)`);

    // Which picks are contracts on HyperEVM, via NOWNodes' /evm. Evidence only: nothing here selects or excludes.
    const code = this.o.contractCode ?? (process.env.CONTRACT_CHECK === "on" && process.env.NOWNODES_API_KEY ? nownodesCode(process.env.NOWNODES_API_KEY) : undefined);
    if (code) {
      try {
        const contracts = await checkContracts(score.addresses, code);
        await sql`update selection_runs set finalists = coalesce(finalists, '{}'::jsonb) || ${JSON.stringify({ contracts })}::text::jsonb where id = ${id}`;
        log("contract check", { id, checked: contracts.checked, contracts: contracts.contracts.length, unread: contracts.unread.length, ms: contracts.ms });
      } catch (e) {
        log("contract check not recorded", { id, error: String((e as Error)?.message ?? e) });
      }
    }

    // Live positions and equity of each finalist (the review's evidence and the leverage check).
    type State = Parameters<typeof positionsFromStates>[0][number] & { marginSummary: { accountValue: string } };
    const hl = this.info(600);
    const positions = new Map<string, LivePosition[]>();
    const equity = new Map<string, number>();
    for (const address of score.addresses) {
      const states = await Promise.all(ELIGIBLE_DEXES.map((dex) => hl.post<State>({ type: "clearinghouseState", user: address, ...(dex ? { dex } : {}) }, 2)));
      positions.set(address.toLowerCase(), positionsFromStates(states));
      equity.set(address.toLowerCase(), states.reduce((sum, s) => sum + Number(s.marginSummary.accountValue), 0));
    }
    // Each pick's largest same-direction overlap with another pick. Evidence only: nothing here selects.
    try {
      const overlap = summarizeOverlap(score.addresses, positions, policy.maxExposureOverlap);
      await sql`update selection_runs set finalists = coalesce(finalists, '{}'::jsonb) || ${JSON.stringify({ overlap })}::text::jsonb where id = ${id}`;
    } catch (e) {
      log("overlap not recorded", { id, error: String((e as Error)?.message ?? e) });
    }
    // Measured evidence (evidence.ts): fills over the last 30 days, paged forward (2,000 a page),
    // and which markets the copy loop can trade.
    const eligible = new Set([...(await fetchOpenInterest())].filter(([, usd]) => usd >= ENTER_OI_USD).map(([asset]) => asset));
    const byInput = new Map(inputs.map((input) => [input.address.toLowerCase(), input]));
    const measured = new Map<string, Measured>();
    const holds = new Map<string, HoldMeasures>();
    const liquidatedAt = new Map<string, number>();
    for (const address of score.addresses.map((a) => a.toLowerCase())) {
      const fills: HlFill[] = [];
      let startTime = this.now() - EVIDENCE_DAYS * 24 * HOUR;
      for (let page = 0; page < 5; page++) {
        const rows = await hl.post<HlFill[]>({ type: "userFillsByTime", user: address, startTime, aggregateByTime: true }, 20, (f) => f.length);
        fills.push(...rows);
        if (rows.length < FILLS_PAGE) break;
        startTime = rows[rows.length - 1]!.time + 1;
      }
      const m = measure({ input: byInput.get(address)!, fills, positions: positions.get(address) ?? [], eligible, nowMs: this.now() });
      measured.set(address, m);
      holds.set(address, holdMeasures(fills, byInput.get(address)!.accountValue, m.averageLeverage, this.now()));
      const liquidations = fills.filter((f) => f.liquidation?.liquidatedUser?.toLowerCase() === address).map((f) => f.time);
      if (liquidations.length) liquidatedAt.set(address, Math.max(...liquidations));
    }
    const pairOverlap = (a: string, b: string) => exposureOverlap(positions.get(a) ?? [], positions.get(b) ?? []);
    await sql`update selection_runs set finalists = coalesce(finalists, '{}'::jsonb) || ${JSON.stringify({ measured: Object.fromEntries(measured), holds: Object.fromEntries(holds) })}::text::jsonb where id = ${id}`;
    const built = buildReviewInput({ score, inputs, positions, policy, asOfMs: this.now(), ttlMs: policy.maxFrameAgeMs, measured, overlap: pairOverlap });

    // Gross leverage if every chosen source keeps today's book (README §4.6 policy check).
    const assess = (sources: readonly { sourceAddress: string; weight: number }[]): Assessment => {
      let grossLeverage = 0;
      for (const s of sources) {
        const address = s.sourceAddress.toLowerCase();
        const notional = (positions.get(address) ?? []).reduce((sum, p) => sum + Math.abs(p.signedNotionalUsd), 0);
        const value = equity.get(address) ?? 0;
        grossLeverage += value > 0 ? (s.weight * notional) / value : 0;
      }
      const executableTargets = sources.filter((s) => s.weight * policy.capitalUsd >= policy.minOrderUsd).length;
      return { executableTargets, grossLeverage, withinPolicy: grossLeverage <= policy.maxGrossLeverage };
    };

    const audit: unknown[] = [];
    const stageRows: Record<string, Row[][]> = {};
    const deps = openAIPaperCommittee(
      { apiKey: this.o.openAiKey ?? "", model: this.o.model ?? "gpt-4.1-mini-2025-04-14" },
      {
        clock: this.now,
        agentTimeoutMs: 60_000,
        assess,
        audit: async (stage, evidence, outputs, draft) =>
          outputs.map((output) => {
            const record = { stage, evidenceHash: evidence.evidenceHash, output, ...(draft ? { draftHash: draft.draftHash } : {}) };
            audit.push(record);
            if ("results" in output) (stageRows[stage] ??= []).push(output.results);
            return commitment("perpparrot:audit-record:v1", record);
          }),
      },
    );
    const receipt = await runCommitteeReview(built.frame, policy, built.addresses, built.evidence, this.now(), deps);
    const { manifest } = receipt;
    const field = (stage: string, candidate: number, name: string) => stageRows[stage]?.[0]?.find((r) => r.candidate === candidate)?.[name] ?? null;
    const summary = built.frame.candidates.map(({ candidate }) => ({
      candidate,
      address: built.addresses.get(candidate),
      aggressiveFit: field("role", candidate, "aggressiveFit"),
      reject: field("role", candidate, "reject"),
      leverageRisk: field("risk", candidate, "leverageRisk"),
      evidenceRisk: field("risk", candidate, "evidenceRisk"),
    }));
    const review = {
      summary,
      skipped: [...score.skipped, ...built.skipped],
      manifest: { status: manifest.status, reason: manifest.reason, sources: manifest.sources.map((s) => ({ address: s.sourceAddress, weight: s.weight })) },
      receiptHash: receipt.receiptHash,
      audit,
    };
    await sql`update selection_runs set review = ${JSON.stringify(review)}::text::jsonb where id = ${id}`;
    // The bench (ROSTER.md §4.1): the wallets the AI approves, with their fit and hold measures. The
    // roster step seats them into open seats; nothing is activated here.
    const fitKey = `${policy.bucket.toLowerCase()}Fit`;
    const approved =
      manifest.status === "VALID"
        ? manifest.sources.map((s) => ({ sourceAddress: s.sourceAddress, fit: Number(field("role", s.candidate, fitKey) ?? 0) }))
        : this.o.gate === "strict"
          ? []
          : approvedCandidates(built.frame.candidates.map((c) => c.candidate), stageRows.role?.[0] ?? [], stageRows.risk?.[0] ?? [], policy, built.addresses);
    const bench: BenchEntry[] = approved.map((a) => {
      const address = a.sourceAddress.toLowerCase();
      const h = holds.get(address) ?? { copyableShare: null, closedPositions: 0, turnoverPerDay: null, tradedPerDayOverEquity: null };
      return { address, fit: a.fit, approvedAt: this.now(), ...h, passesHold: passesHoldGate(h), averageLeverage: measured.get(address)?.averageLeverage ?? null };
    });
    // Every reviewed wallet's verdict, for the roster's seat review (warning signs, approval, fit).
    const approvedSet = new Set(bench.map((b) => b.address));
    const verdicts: Verdict[] = built.frame.candidates.map(({ candidate }) => {
      const address = built.addresses.get(candidate)!.toLowerCase();
      const risk = stageRows.risk?.[0]?.find((r) => r.candidate === candidate);
      const riskReject = Number(field("role", candidate, "reject") ?? 0) >= policy.riskRejectThreshold || RISKS.some((name) => Number(risk?.[name] ?? 0) > policy.riskRejectThreshold);
      return { address, approved: approvedSet.has(address), riskReject, fit: Number(field("role", candidate, fitKey) ?? 0), liquidatedAt: liquidatedAt.get(address) ?? null };
    });
    const status = bench.length || scope === "seats" ? "benched" : "rejected";
    await sql`update selection_runs set review = review || ${JSON.stringify({ gate: manifest.status === "VALID" ? "strict" : this.o.gate ?? "basic", bench, verdicts, ...(scope === "seats" ? { scope } : {}) })}::text::jsonb,
      status = ${status}, finished_at = now() where id = ${id}`;
    const copyable = bench.filter((b) => b.passesHold).length;
    log("selection benched", { id, approved: bench.length, copyable });
    return { status, reason: `${copyable} of ${bench.length} approved wallets pass the hold gate` };
  }

  // Every 10 minutes (ROSTER.md §7): observe the latest snapshot, apply the 50% loss rule and the
  // seat lifecycle, fill open seats from the bench, then freeze the seats and activate them if
  // they changed. Seeds the roster from the active configuration the first time.
  async roster(): Promise<{ status: string; seats: number; changes: string[]; reason?: string }> {
    const { sql, log, policy } = this.o;
    const now = this.now();
    const at = new Date(now).toISOString();
    const changes: string[] = [];
    const event = async (address: string, kind: string, detail: Record<string, unknown> = {}) => {
      await sql`insert into roster_events (at, address, kind, detail) values (${at}, ${address}, ${kind}, ${JSON.stringify(detail)}::text::jsonb)`;
      changes.push(`${kind} ${address}${typeof detail.reason === "string" ? ` (${detail.reason})` : ""}`);
    };

    // Seed: the active configuration's wallets, seated (they were admitted by earlier selections).
    const [{ ever }] = await sql`select count(*)::int as ever from roster_seats`;
    if (ever === 0) {
      const configuration = await activeConfiguration(sql);
      for (const source of configuration?.sources ?? []) {
        await sql`insert into roster_seats (address, state, weight_units, admitted_at, min_tenure_until)
          values (${source.sourceAddress.toLowerCase()}, 'seated', ${source.weightUnits}, ${at}, ${at})`;
        await event(source.sourceAddress.toLowerCase(), "seeded", { weightUnits: source.weightUnits, configuration: configuration!.configurationHash });
      }
    }

    // A seat without its 30-day average leverage (seeded, or admitted before it was kept) takes it
    // from the latest review that measured the wallet, so the snapshot's normalization covers it.
    await sql`update roster_seats s set average_leverage = (
        select (r.finalists -> 'measured' -> s.address ->> 'averageLeverage')::double precision from selection_runs r
        where r.finalists -> 'measured' -> s.address ->> 'averageLeverage' is not null order by r.started_at desc limit 1)
      where s.average_leverage is null and s.state in ${sql([...ACTIVE])}`;

    // 1. Observe the latest stored snapshot (flat tracking; winding-down caps).
    let seats = await this.activeSeats();
    const [snap] = await sql`select run_at, body from run_snapshots order by run_at desc limit 1`;
    if (snap) {
      const entries = snapshotEntries(JSON.parse(snap.body as string) as PositionsSnapshot);
      seats = seats.map((seat) => observe(seat, Number(snap.run_at), entries.get(seat.address)));
    }

    // 2. The one immediate removal: a 50% trading loss since admission (PnL, so withdrawals don't
    // count). A seat without a baseline gets one now. A failed read skips the check this time.
    const hl = this.info(900);
    const decided = new Map<string, Transition & { detail?: Record<string, unknown> }>();
    for (const seat of seats) {
      let reading: ReturnType<typeof pnlAndEquity> = null;
      try {
        reading = pnlAndEquity(await hl.post<unknown>({ type: "portfolio", user: seat.address }));
      } catch (e) {
        log("roster: portfolio read failed", { address: seat.address, error: (e as Error).message });
      }
      if (!reading) continue;
      if (seat.pnlAtAdmission === null || seat.equityAtAdmission === null) {
        seat.pnlAtAdmission = reading.pnl;
        seat.equityAtAdmission = reading.equity;
      } else if (lossBreached(seat, reading.pnl)) {
        decided.set(seat.address, { to: "removed", reason: "trading loss", detail: { pnlAtAdmission: seat.pnlAtAdmission, pnlNow: reading.pnl, equityAtAdmission: seat.equityAtAdmission } });
      }
    }

    // 3. Lifecycle: tenure ends, idle and exit releases, wind-down ends.
    for (const seat of seats) {
      const next = decided.get(seat.address) ?? transition(seat, now);
      if (next) {
        seat.state = next.to;
        await event(seat.address, next.to, { reason: next.reason, ...((next as { detail?: Record<string, unknown> }).detail ?? {}) });
      }
      const ended = seat.state === "released" || seat.state === "removed";
      await sql`update roster_seats set state = ${seat.state}, flat_since = ${seat.flatSince === null ? null : new Date(seat.flatSince).toISOString()},
          flat_runs = ${seat.flatRuns}, last_run_at = ${seat.lastRunAt}, equity_at_admission = ${seat.equityAtAdmission},
          pnl_at_admission = ${seat.pnlAtAdmission}, caps = ${seat.caps === null ? null : JSON.stringify(seat.caps)}::text::jsonb,
          released_at = ${ended ? at : null}, release_reason = ${ended ? (next?.reason ?? null) : null}
        where address = ${seat.address} and state in ${sql([...ACTIVE])}`;
    }

    // 3b. Warning signs (ROSTER.md §4.4–4.5): wind down, never sell. Turning high-frequency is checked
    // every step; the rest at the 12-hourly seat review.
    const entries = snap ? snapshotEntries(JSON.parse(snap.body as string) as PositionsSnapshot) : new Map<string, SnapshotEntry>();
    const windDown = async (seat: Seat, reason: string) => {
      seat.state = "winding_down";
      seat.caps = capsFrom(entries.get(seat.address));
      seat.windDownUntil = now + ROSTER.windDownHours * HOUR;
      await sql`update roster_seats set state = 'winding_down', caps = ${JSON.stringify(seat.caps)}::text::jsonb,
        wind_down_until = ${new Date(seat.windDownUntil).toISOString()} where address = ${seat.address} and state in ${sql([...ACTIVE])}`;
      await event(seat.address, "winding_down", { reason, caps: seat.caps });
    };
    const trading = () => seats.filter((s) => s.state === "probation" || s.state === "seated");
    if (trading().length) {
      const fast = await sql`select address from pipeline_accounts where address in ${sql(trading().map((s) => s.address))} and orders_per_day > 100`;
      for (const { address } of fast as { address: string }[]) await windDown(seats.find((s) => s.address === address)!, "high-frequency");
    }
    const due = trading().filter((s) => s.reviewedAt === null || now - s.reviewedAt >= SEAT_REVIEW_HOURS * HOUR);
    if (due.length) {
      const verdicts = await this.reviewSeats(trading().map((s) => s.address));
      if (verdicts) {
        const qualified = new Set<string>((await sql`select address from pipeline_accounts where qualified_at is not null`).map((r: { address: string }) => r.address));
        const approved = verdicts.filter((v) => v.approved && v.fit > 0);
        const meanFit = approved.length ? approved.reduce((sum, v) => sum + v.fit, 0) / approved.length : 0;
        const seatUnits = ((1 - policy.cashBuffer) / targetSeats(seats.filter((s) => ACTIVE.includes(s.state)), [])) * 1e6;
        for (const seat of trading()) {
          const verdict = verdicts.find((v) => v.address === seat.address);
          const refreshed = verdict?.approved && meanFit > 0
            ? Math.min(Math.floor(seatUnits * Math.min(Math.max(verdict.fit / meanFit, ROSTER.fitModifier[0]), ROSTER.fitModifier[1])), Math.floor(policy.maxSourceWeight * 1e6))
            : null;
          const outcome = reviewSeat(seat, verdict, qualified.has(seat.address), now, refreshed);
          seat.unqualifiedReviews = outcome.unqualifiedReviews;
          await sql`update roster_seats set reviewed_at = ${at}, unqualified_reviews = ${outcome.unqualifiedReviews} where address = ${seat.address} and state in ${sql([...ACTIVE])}`;
          if (outcome.windDown) await windDown(seat, outcome.windDown);
          else if (outcome.weightUnits !== undefined) {
            // A raise never takes the roster past 90%.
            const room = Math.floor((1 - policy.cashBuffer) * 1e6) - seats.filter((s) => ACTIVE.includes(s.state)).reduce((sum, s) => sum + s.weightUnits, 0);
            const units = Math.min(outcome.weightUnits, seat.weightUnits + Math.max(room, 0));
            if (Math.abs(units - seat.weightUnits) > 50_000) {
              await event(seat.address, "weight", { reason: "re-review", from: seat.weightUnits, to: units, fit: verdict!.fit });
              seat.weightUnits = units;
              await sql`update roster_seats set weight_units = ${units}, fit = ${verdict!.fit} where address = ${seat.address} and state in ${sql([...ACTIVE])}`;
            }
          }
        }
      }
    }

    // 4. Fill open seats from the fresh bench, within the pace limits.
    const active = seats.filter((s) => ACTIVE.includes(s.state));
    const [latest] = await sql`select id, review -> 'bench' as bench from selection_runs
      where status = 'benched' and (review ->> 'scope') is distinct from 'seats' order by started_at desc limit 1`;
    const bench = ((latest?.bench ?? []) as (BenchEntry & { approvedAt: number })[]).map((b) => ({ ...b, approvedAt: Number(b.approvedAt) }));
    const cooling = new Set<string>(
      (await sql`select address from roster_seats where released_at > ${new Date(now - ROSTER.cooldownHours * HOUR).toISOString()}`).map((r: { address: string }) => r.address),
    );
    const [counts] = await sql`select count(*) filter (where at > ${new Date(now - HOUR).toISOString()})::int as hour, count(*)::int as day
      from roster_events where kind = 'admitted' and at > ${new Date(now - 24 * HOUR).toISOString()}`;
    const admissions = planAdmissions({
      active, bench, cooling, admittedLastHour: counts.hour, admittedLastDay: counts.day, nowMs: now,
      cashBuffer: policy.cashBuffer, maxSourceWeight: policy.maxSourceWeight,
    });
    for (const a of admissions) {
      let reading: ReturnType<typeof pnlAndEquity> = null;
      try {
        reading = pnlAndEquity(await hl.post<unknown>({ type: "portfolio", user: a.entry.address }));
      } catch {
        // The baseline is taken on the next roster step.
      }
      await sql`insert into roster_seats (address, state, weight_units, fit, turnover_per_day, traded_per_day_over_equity, admitted_at,
          min_tenure_until, admitted_by, equity_at_admission, pnl_at_admission, average_leverage, reviewed_at)
        values (${a.entry.address}, 'probation', ${a.weightUnits}, ${a.entry.fit}, ${a.entry.turnoverPerDay}, ${a.entry.tradedPerDayOverEquity}, ${at},
          ${new Date(a.minTenureUntil).toISOString()}, ${latest.id}, ${reading?.equity ?? null}, ${reading?.pnl ?? null}, ${a.entry.averageLeverage ?? null},
          ${new Date(a.entry.approvedAt).toISOString()})`; // its bench approval is its review: the next seat review is 12 h after it
      await event(a.entry.address, "admitted", { reason: "open seat", weightUnits: a.weightUnits, fit: a.entry.fit, copyableShare: a.entry.copyableShare,
        turnoverPerDay: a.entry.turnoverPerDay, tenureUntil: new Date(a.minTenureUntil).toISOString() });
    }

    // 5. Freeze the seats; activate when they differ from the active configuration.
    const seated = await this.activeSeats();
    if (seated.length < ROSTER.minSeats) {
      log("roster below the freeze's minimum", { seats: seated.length, changes });
      return { status: "below minimum", seats: seated.length, changes, reason: `${seated.length} seats; a configuration needs ${ROSTER.minSeats}` };
    }
    const ceilingUnits = Math.floor(policy.maxSourceWeight * 1e6);
    const sources = seated
      .map((s) => ({ sourceAddress: s.address, weightUnits: Math.min(s.weightUnits, ceilingUnits) }))
      .sort((a, b) => (a.sourceAddress < b.sourceAddress ? -1 : 1))
      .map((s, candidate) => ({ candidate, ...s, ceilingUnits }));
    const configurationNow = await activeConfiguration(sql);
    const unchanged =
      configurationNow?.policyHash === policyCommitment(policy) &&
      configurationNow?.sources.length === sources.length &&
      sources.every((s) => configurationNow.sources.some((c) => c.sourceAddress.toLowerCase() === s.sourceAddress && c.weightUnits === s.weightUnits));
    if (unchanged) {
      if (changes.length) log("roster changed, configuration kept", { changes });
      return { status: "kept", seats: seated.length, changes };
    }
    const [review] = await sql`select review ->> 'receiptHash' as receipt from selection_runs where status = 'benched' order by started_at desc limit 1`;
    const payload: Omit<FrozenConfiguration, "configurationHash"> = {
      schemaVersion: "1.0.0",
      account: this.o.account.toLowerCase(),
      chainId: 999,
      frozenAtMs: now,
      reviewHash: (review?.receipt as string | undefined) ?? commitment("perpparrot:roster:v1", sources),
      policy: structuredClone(policy) as unknown as FrozenConfiguration["policy"],
      policyHash: policyCommitment(policy),
      sources,
      cashUnits: 1e6 - sources.reduce((sum, s) => sum + s.weightUnits, 0),
    } as Omit<FrozenConfiguration, "configurationHash">;
    const configuration = { ...payload, configurationHash: commitment("perpparrot:frozen:v1", payload) } as FrozenConfiguration;
    checkFrozenConfiguration(keccakUtf8, configuration, configuration.configurationHash, now);
    await sql.begin(async (tx) => {
      await tx`update configurations set status = 'retired' where status = 'active'`;
      await tx`insert into configurations (hash, configuration, status, selection_id, activated_at)
        values (${configuration.configurationHash}, ${JSON.stringify(configuration)}::text::jsonb, 'active', ${latest?.id ?? null}, now())
        on conflict (hash) do update set status = 'active', activated_at = now()`;
    });
    log("roster activated", { hash: configuration.configurationHash, seats: seated.length, changes });
    return { status: "activated", seats: seated.length, changes, reason: configuration.configurationHash };
  }

  // The 12-hourly seat review: the committee over the wallets holding seats, as a 'seats' selection
  // run. Their verdicts, or undefined when another review is running or this one fails.
  private async reviewSeats(addresses: string[]): Promise<Verdict[] | undefined> {
    const { sql, log } = this.o;
    // One review at a time; a failed seat review is retried after 30 minutes.
    const [busy] = await sql`select id from selection_runs where status = 'running'
      or (status = 'failed' and (finalists ->> 'scope') = 'seats' and started_at > ${new Date(this.now() - 30 * 60_000).toISOString()}) limit 1`;
    if (busy) return undefined;
    const rows = (await sql`
      select address, kind, account_value, closed, portfolio, trade_count, maker_share, orders_per_day
      from pipeline_accounts where address in ${sql(addresses)} and portfolio is not null`) as AccountRow[];
    const inputs = rows.map(toInput);
    // Marked as a seat review from the start, so a failure is recognised as one.
    const [{ id }] = await sql`insert into selection_runs (started_at, status, accounts, finalists)
      values (${new Date(this.now()).toISOString()}, 'running', ${inputs.length}, ${JSON.stringify({ scope: "seats" })}::text::jsonb) returning id`;
    try {
      const result = scoreCandidates(inputs, { finalists: inputs.length, allowUnknown: ["minTrades"] });
      if (result.finalists.length === 0) throw new Error("no seat passed Score's filters");
      await this.review(id as number, inputs, result, 0, undefined, "seats");
      const [run] = await sql`select review -> 'verdicts' as verdicts, finalists -> 'holds' as holds, finalists -> 'measured' as measured from selection_runs where id = ${id}`;
      // Fresh 30-day average leverage for each seat (the snapshot's normalization).
      for (const [address, m] of Object.entries((run?.measured ?? {}) as Record<string, Measured>)) {
        if (m.averageLeverage === null) continue;
        await sql`update roster_seats set average_leverage = ${m.averageLeverage} where address = ${address} and state in ${sql([...ACTIVE])}`;
      }
      // Fresh hold measures for each seat (the monitored turnover; seeded seats start without them).
      for (const [address, h] of Object.entries((run?.holds ?? {}) as Record<string, HoldMeasures>)) {
        await sql`update roster_seats set turnover_per_day = ${h.turnoverPerDay}, traded_per_day_over_equity = ${h.tradedPerDayOverEquity}
          where address = ${address} and state in ${sql([...ACTIVE])}`;
      }
      return (run?.verdicts ?? []) as Verdict[];
    } catch (e) {
      log("seat review failed", { id, error: (e as Error).message });
      await sql`update selection_runs set status = 'failed', error = ${(e as Error).message}, finished_at = now() where id = ${id}`;
      return undefined;
    }
  }

  private async activeSeats(): Promise<Seat[]> {
    const rows = await this.o.sql`select * from roster_seats where state in ${this.o.sql([...ACTIVE])} order by admitted_at, address`;
    return rows.map(seatFromRow);
  }

  // For /pipeline: the seats, recent roster events and the roster's implied turnover (monitored only).
  private async rosterStatus() {
    const { sql } = this.o;
    try {
      const seats = await this.activeSeats();
      const events = await sql`select at, address, kind, detail from roster_events order by at desc, id desc limit 30`;
      return { seats, events, impliedTurnover: impliedTurnover(seats) };
    } catch {
      return null; // the roster migration hasn't run
    }
  }
}

const iso = (value: unknown): number | null => (value === null || value === undefined ? null : new Date(value as string | Date).getTime());
const num = (value: unknown): number | null => (value === null || value === undefined ? null : Number(value));

const seatFromRow = (r: Record<string, unknown>): Seat => ({
  address: r.address as string,
  state: r.state as Seat["state"],
  weightUnits: Number(r.weight_units),
  fit: num(r.fit),
  turnoverPerDay: num(r.turnover_per_day),
  tradedPerDayOverEquity: num(r.traded_per_day_over_equity),
  admittedAt: iso(r.admitted_at)!,
  minTenureUntil: iso(r.min_tenure_until)!,
  flatSince: iso(r.flat_since),
  flatRuns: Number(r.flat_runs),
  lastRunAt: num(r.last_run_at),
  equityAtAdmission: num(r.equity_at_admission),
  pnlAtAdmission: num(r.pnl_at_admission),
  windDownUntil: iso(r.wind_down_until),
  caps: (r.caps as Record<string, number> | null) ?? null,
  averageLeverage: num(r.average_leverage),
  reviewedAt: iso(r.reviewed_at),
  unqualifiedReviews: Number(r.unqualified_reviews ?? 0),
});

// A snapshot's sources as the roster reads them: equity and signed notional per perp, in USD.
export const snapshotEntries = (snapshot: PositionsSnapshot): Map<string, SnapshotEntry> =>
  new Map(
    snapshot.sources.map((s) => [
      s.address.toLowerCase(),
      { equity: Number(s.equityE6) / 1e6, positions: s.positions.map((p) => ({ asset: p.asset, notional: Number(p.notionalE6) / 1e6 })) },
    ]),
  );

// The caps of the seats winding down, for the snapshot (shared/snapshot.ts windDown). Before the roster
// migration runs there are none.
export const windDownCaps = async (sql: SQL): Promise<WindDownSource[]> => {
  try {
    const rows = await sql`select address, caps from roster_seats where state = 'winding_down' and caps is not null`;
    return rows.map((r: { address: string; caps: Record<string, number> }) => ({
      address: r.address,
      caps: Object.entries(r.caps).map(([asset, leverage]) => ({ asset, leverageE9: BigInt(Math.round(leverage * 1e9)).toString() })),
    }));
  } catch {
    return [];
  }
};

// Each seat's 30-day average leverage, for the snapshot's normalization. Before the migration that adds
// it there are none, and every wallet is copied as it is.
export const seatLeverage = async (sql: SQL): Promise<{ address: string; averageLeverage: number | null }[]> => {
  try {
    const rows = await sql`select address, average_leverage from roster_seats where state in ${sql([...ACTIVE])}`;
    return rows.map((r: { address: string; average_leverage: number | null }) => ({ address: r.address, averageLeverage: r.average_leverage === null ? null : Number(r.average_leverage) }));
  } catch {
    return [];
  }
};

// The active configuration, if the pipeline has activated one.
export const activeConfiguration = async (sql: SQL): Promise<FrozenConfiguration | undefined> => {
  const [row] = await sql`select configuration from configurations where status = 'active'`;
  return row?.configuration as FrozenConfiguration | undefined;
};

export const reviewPolicy = (configuration: { policy: Record<string, unknown> }): Policy => {
  const policy = structuredClone(configuration.policy) as unknown as Policy;
  validate("bucket-policy", policy);
  return policy;
};

// evidenceRisk is left out: it rates the very gap this gate stands in for (every finalist scores ~80).
const RISKS = ["drawdownRisk", "leverageRisk", "concentrationRisk", "pathRisk", "executionRisk"];

// The basic gate. The review core requires measured evidence (out-of-sample windows, execution
// fit, exposure overlap) that the frame doesn't carry yet (docs/ingest/PIPELINE.md PR D), so its
// compile step keeps no one. Until then: keep finalists the Role model doesn't reject and with no
// Risk score above the policy's reject threshold, weight them by the Role model's fit
// for the bucket, cap each at maxSourceWeight, keep the cash buffer, and scale down to the
// policy's gross leverage. At most MAX_SOURCES (15) sources.
// The finalists the AI approves (the basic gate's filter, and the roster's bench): not rejected by the
// Role model, no Risk score above the reject threshold, positive fit for the bucket. Best fit first.
export const approvedCandidates = (
  candidates: number[],
  role: Row[],
  risk: Row[],
  policy: Policy,
  addresses: ReadonlyMap<number, string>,
): { candidate: number; sourceAddress: string; fit: number }[] => {
  const fitKey = `${policy.bucket.toLowerCase()}Fit`;
  return candidates
    .flatMap((candidate) => {
      const r = role.find((row) => row.candidate === candidate);
      const k = risk.find((row) => row.candidate === candidate);
      if (!r || !k || Number(r.reject) >= policy.riskRejectThreshold) return [];
      if (RISKS.some((name) => Number(k[name]) > policy.riskRejectThreshold)) return [];
      const fit = Number(r[fitKey]);
      return fit > 0 && addresses.has(candidate) ? [{ candidate, sourceAddress: addresses.get(candidate)!, fit }] : [];
    })
    .sort((a, b) => b.fit - a.fit || a.candidate - b.candidate);
};

export const basicSources = (
  candidates: number[],
  role: Row[],
  risk: Row[],
  policy: Policy,
  addresses: ReadonlyMap<number, string>,
  assess: (sources: { sourceAddress: string; weight: number }[]) => Assessment,
): { candidate: number; sourceAddress: string; weight: number; fit: number }[] => {
  const kept = approvedCandidates(candidates, role, risk, policy, addresses).slice(0, MAX_SOURCES);
  const total = kept.reduce((sum, c) => sum + c.fit, 0);
  let sources = kept.map((c) => ({ ...c, weight: Math.min(((1 - policy.cashBuffer) * c.fit) / total, policy.maxSourceWeight) }));
  const { grossLeverage } = assess(sources);
  if (grossLeverage > policy.maxGrossLeverage) {
    const scale = (0.95 * policy.maxGrossLeverage) / grossLeverage;
    sources = sources.map((s) => ({ ...s, weight: s.weight * scale }));
  }
  return sources;
};

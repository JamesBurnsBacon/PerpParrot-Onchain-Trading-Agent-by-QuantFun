// The selection pipeline (docs/ingest/PIPELINE.md), run by the backend's cron routes:
//   scan:    every leaderboard trader and HyperCore vault with ≥ $10k (~14k; every 12 h)
//   refresh: portfolios of the scan within 12 h; portfolio + fills of the qualified list hourly
//            (every 5 min, within a weight budget)
//   select:  every 10 min: Score qualifies ~250 once the scan is refreshed, picks 25 from them
//            (high-frequency traders left out) → AI review (Role, Risk, Red-Team) when the 25
//            change → freeze → activate when the sources change
// The active configuration is what the 10-minute mirror loop copies from its next run on.
import type { SQL } from "bun";
import { fillStats, isHighFrequency, pickLeaderboard, sameAddresses, scoringWindows, type Fill, type LeaderboardRow, type Tracked } from "./derive";
import { PacedInfo, getJson } from "./hl";
import { routingStats } from "./info-router";
import { overlapGuard, readPositionsBulk, type GuardSummary, type PositionReader } from "./overlap-pick";
import { pickVaults } from "./vaults";
import { parsePortfolio, scoreCandidates, toFrameCandidates, type ScoreInput, type ScoreResult } from "../score";
import { buildReviewInput, positionsFromStates, type LivePosition } from "../../review/input.ts";
import { summarizeOverlap } from "../../review/overlap.ts";
import { openAIPaperCommittee } from "../../review/models/openai-paper.ts";
import { runCommitteeReview } from "../../review/committee/workflow.ts";
import type { Assessment } from "../../review/workflow.ts";
import { commitment } from "../../../shared/src/commitments.ts";
import { proposeFreeze } from "../../../shared/src/frozen.ts";
import { validate } from "../../../shared/src/validate.ts";
import type { Policy, Row } from "../../../shared/src/contracts.ts";
import { checkFrozenConfiguration, type FrozenConfiguration } from "../../../shared/frozen";
import { ELIGIBLE_DEXES } from "../../../shared/snapshot";
import { keccakUtf8 } from "../snapshot";

const HOUR = 3_600_000;
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
      address: t.address, source: t.source, kind: t.kind, name: t.name, account_value: t.accountValue, closed: t.closed, listed_at: listedAt,
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
  // (portfolio only), primary sources first. Scans first when the latest scan is over 12 h old.
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
        order by qualified_at is null, not primary_source, refreshed_at nulls first limit ${CLAIMS} for update skip locked)
      returning address, qualified_at is not null as qualified, primary_source, refreshed_at`) as { address: string; qualified: boolean; primary_source: boolean; refreshed_at: Date | null }[];
    claimed.sort((a, b) => Number(b.qualified) - Number(a.qualified) || Number(b.primary_source) - Number(a.primary_source) || (a.refreshed_at?.getTime() ?? 0) - (b.refreshed_at?.getTime() ?? 0));
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
              update pipeline_accounts set portfolio = ${portfolio}::jsonb, trade_count = ${tradeCount}, maker_share = ${makerShare},
                orders_per_day = ${ordersPerDay}, refreshed_at = now(), fills_at = now(), attempted_at = null, error = null
              where address = ${address}`;
          } else {
            await sql`update pipeline_accounts set portfolio = ${portfolio}::jsonb, refreshed_at = now(), attempted_at = null, error = null where address = ${address}`;
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
    const [latest] = await sql`select id, finalists, review -> 'summary' as summary from selection_runs order by started_at desc limit 1`;
    return { accounts: counts, selections: runs, active: active ?? null, latest: latest ?? null, routing: routingStats() };
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

    // The AI review runs only when the 25 change (a rejected set isn't reviewed again).
    const [last] = await sql`select finalists -> 'finalists' as finalists from selection_runs
      where status <> 'failed' and finalists is not null order by started_at desc limit 1`;
    const lastPicks = ((last?.finalists ?? []) as { address: string }[]).map((f) => f.address);
    if (!force && sameAddresses(lastPicks, result.finalists)) return { status: "unchanged" };
    // One review at a time, and a failed one is retried after 30 minutes.
    const [busy] = await sql`select status from selection_runs
      where status = 'running' or (status = 'failed' and started_at > now() - interval '30 minutes') limit 1`;
    if (busy && (busy.status === "running" || !force)) return { status: "waiting", reason: busy.status === "running" ? "a review is running" : "a review failed in the last 30 minutes" };

    const [{ id }] = await sql`insert into selection_runs (started_at, status, accounts) values (${new Date(this.now())}, 'running', ${inputs.length}) returning id`;
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
      from pipeline_accounts where listed_at >= ${listed} ::timestamptz - interval '10 minutes'`) as (AccountRow & { refreshed_at: Date | null; primary_source: boolean; error: string | null })[];
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

  private async review(id: number, inputs: ScoreInput[], result: ScoreResult, highFrequency: number, guard?: GuardSummary): Promise<{ status: string; reason?: string }> {
    const { sql, log, policy } = this.o;
    const score = toFrameCandidates(result);
    const byAddress = new Map(result.candidates.map((c) => [c.address, c]));
    const finalists = result.finalists.map((address) => ({ address, kind: byAddress.get(address)?.kind, score: byAddress.get(address)?.score, rank: byAddress.get(address)?.rank }));
    const funnel = result.funnel;
    await sql`update selection_runs set finalists = ${{ finalists, funnel, highFrequency, ...(guard ? { overlapGuard: guard } : {}) }}::jsonb where id = ${id}`;
    if (score.candidates.length === 0) throw new Error(`no frame candidates (${result.finalists.length} finalists)`);

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
      await sql`update selection_runs set finalists = coalesce(finalists, '{}'::jsonb) || ${{ overlap }}::jsonb where id = ${id}`;
    } catch (e) {
      log("overlap not recorded", { id, error: String((e as Error)?.message ?? e) });
    }
    const built = buildReviewInput({ score, inputs, positions, policy, asOfMs: this.now(), ttlMs: policy.maxFrameAgeMs });

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
    await sql`update selection_runs set review = ${review}::jsonb where id = ${id}`;
    let payload: Omit<FrozenConfiguration, "configurationHash">;
    if (manifest.status === "VALID") {
      // Freeze for our account (as freezePaperSession: bound to the review receipt).
      const { configurationHash: _, ...proposed } = proposeFreeze(manifest, this.o.account.toLowerCase(), 999, this.now());
      payload = { ...proposed, reviewHash: receipt.receiptHash } as unknown as typeof payload;
    } else {
      const basic = this.o.gate === "strict" ? [] : basicSources(built.frame.candidates.map((c) => c.candidate), stageRows.role?.[0] ?? [], stageRows.risk?.[0] ?? [], policy, built.addresses, assess);
      if (basic.length < Math.max(5, policy.minExecutableTargets)) { // a freeze needs 5–25 sources
        await sql`update selection_runs set status = 'rejected', finished_at = now() where id = ${id}`;
        log("selection rejected", { id, reason: manifest.reason, basicSources: basic.length });
        return { status: "rejected", reason: `${manifest.reason}; basic gate kept ${basic.length}` };
      }
      await sql`update selection_runs set review = review || ${{ gate: "basic", basicSources: basic }}::jsonb where id = ${id}`;
      payload = {
        schemaVersion: "1.0.0",
        account: this.o.account.toLowerCase(),
        chainId: 999,
        frozenAtMs: this.now(),
        reviewHash: receipt.receiptHash,
        policy: structuredClone(policy) as unknown as FrozenConfiguration["policy"],
        policyHash: manifest.policyHash,
        sources: basic
          .map((b) => ({ candidate: b.candidate, sourceAddress: b.sourceAddress.toLowerCase(), weightUnits: Math.floor(b.weight * 1e6), ceilingUnits: Math.floor(policy.maxSourceWeight * 1e6) }))
          .sort((a, b) => a.candidate - b.candidate), // the freeze checks candidate order
        cashUnits: 0,
      };
      payload.cashUnits = 1e6 - payload.sources.reduce((sum, s) => sum + s.weightUnits, 0);
    }
    const configuration = { ...payload, configurationHash: commitment("perpparrot:frozen:v1", payload) } as FrozenConfiguration;
    checkFrozenConfiguration(keccakUtf8, configuration, configuration.configurationHash, this.now());
    // Same sources as the active configuration: keep it, so the executor and paper books don't see
    // a new configuration every 10 minutes.
    const [active] = await sql`select configuration -> 'sources' as sources from configurations where status = 'active'`;
    const activeSources = ((active?.sources ?? []) as { sourceAddress: string }[]).map((s) => s.sourceAddress);
    if (active && sameAddresses(activeSources, configuration.sources.map((s) => s.sourceAddress))) {
      await sql`update selection_runs set status = 'kept', finished_at = now() where id = ${id}`;
      log("configuration kept", { id, sources: activeSources.length });
      return { status: "kept" };
    }
    await sql.begin(async (tx) => {
      await tx`update configurations set status = 'retired' where status = 'active'`;
      await tx`insert into configurations (hash, configuration, status, selection_id, activated_at)
        values (${configuration.configurationHash}, ${configuration}::jsonb, 'active', ${id}, now())
        on conflict (hash) do update set status = 'active', activated_at = now()`;
      await tx`update selection_runs set status = 'activated', configuration_hash = ${configuration.configurationHash}, finished_at = now() where id = ${id}`;
    });
    log("configuration activated", { id, hash: configuration.configurationHash, sources: configuration.sources.length });
    return { status: "activated", reason: configuration.configurationHash };
  }
}

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
// policy's gross leverage. At most 10 sources.
export const basicSources = (
  candidates: number[],
  role: Row[],
  risk: Row[],
  policy: Policy,
  addresses: ReadonlyMap<number, string>,
  assess: (sources: { sourceAddress: string; weight: number }[]) => Assessment,
): { candidate: number; sourceAddress: string; weight: number; fit: number }[] => {
  const fitKey = `${policy.bucket.toLowerCase()}Fit`;
  const kept = candidates
    .flatMap((candidate) => {
      const r = role.find((row) => row.candidate === candidate);
      const k = risk.find((row) => row.candidate === candidate);
      if (!r || !k || Number(r.reject) >= policy.riskRejectThreshold) return [];
      if (RISKS.some((name) => Number(k[name]) > policy.riskRejectThreshold)) return [];
      const fit = Number(r[fitKey]);
      return fit > 0 && addresses.has(candidate) ? [{ candidate, sourceAddress: addresses.get(candidate)!, fit }] : [];
    })
    .sort((a, b) => b.fit - a.fit || a.candidate - b.candidate)
    .slice(0, 10);
  const total = kept.reduce((sum, c) => sum + c.fit, 0);
  let sources = kept.map((c) => ({ ...c, weight: Math.min(((1 - policy.cashBuffer) * c.fit) / total, policy.maxSourceWeight) }));
  const { grossLeverage } = assess(sources);
  if (grossLeverage > policy.maxGrossLeverage) {
    const scale = (0.95 * policy.maxGrossLeverage) / grossLeverage;
    sources = sources.map((s) => ({ ...s, weight: s.weight * scale }));
  }
  return sources;
};

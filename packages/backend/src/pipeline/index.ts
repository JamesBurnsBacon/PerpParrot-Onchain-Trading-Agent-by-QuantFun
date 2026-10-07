// The basic selection pipeline (docs/ingest/PIPELINE.md), run by the backend's cron routes:
//   discover: 100 leaderboard traders + 100 vaults (daily, or when nothing is tracked)
//   refresh:  portfolio + fills for the stalest accounts (every 5 min, within a weight budget)
//   select:   Score → AI review (Role, Risk, Red-Team) → freeze → activate (06:00 and 18:00 UTC)
// The active configuration is what the 10-minute mirror loop copies from its next run on.
import type { SQL } from "bun";
import { fillStats, pickLeaderboard, selectionDue, type Fill, type LeaderboardRow, type Tracked } from "./derive";
import { PacedInfo, getJson } from "./hl";
import { pickVaults } from "./vaults";
import { parsePortfolio, scoreCandidates, toFrameCandidates, type ScoreInput } from "../score";
import { buildReviewInput, positionsFromStates, type LivePosition } from "../../review/input.ts";
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
const REVIEW_FINALISTS = 15;

export type PipelineOptions = {
  sql: SQL;
  account: string; // HL_ACCOUNT: the configuration is frozen for it
  policy: Policy; // the bucket policy reviews run under (the fixture's Aggressive LIVE policy)
  openAiKey?: string;
  model?: string;
  log: (msg: string, data?: Record<string, unknown>) => void;
  now?: () => number;
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
};

export class Pipeline {
  private readonly now: () => number;

  constructor(private readonly o: PipelineOptions) {
    this.now = o.now ?? Date.now;
  }

  async discover(): Promise<{ leaderboard: number; vaults: number }> {
    const { sql, log } = this.o;
    const vaults = await pickVaults(100, this.now(), log);
    const board = await getJson<{ leaderboardRows: LeaderboardRow[] }>(LEADERBOARD);
    const traders = pickLeaderboard(board.leaderboardRows, 100, new Set(vaults.map((v) => v.address)));
    const listedAt = new Date(this.now());
    for (const t of [...traders, ...vaults] as Tracked[]) {
      await sql`
        insert into pipeline_accounts (address, source, kind, name, account_value, closed, listed_at)
        values (${t.address}, ${t.source}, ${t.kind}, ${t.name}, ${t.accountValue}, ${t.closed}, ${listedAt})
        on conflict (address) do update set source = excluded.source, kind = excluded.kind, name = excluded.name,
          account_value = excluded.account_value, closed = excluded.closed, listed_at = excluded.listed_at`;
    }
    log("pipeline discovered", { leaderboard: traders.length, vaults: vaults.length });
    return { leaderboard: traders.length, vaults: vaults.length };
  }

  // Refreshes the stalest listed accounts until `deadlineMs`; discovers first when the list is a day old.
  async refresh(deadlineMs: number): Promise<{ discovered: boolean; refreshed: number; failed: number }> {
    const { sql, log } = this.o;
    const [{ listed }] = await sql`select max(listed_at) as listed from pipeline_accounts`;
    let discovered = false;
    if (!listed || this.now() - (listed as Date).getTime() > 24 * HOUR) {
      await this.discover();
      discovered = true;
    }
    // Claimed rows are skipped by a concurrent invocation for 10 minutes.
    const claimed = await sql`
      update pipeline_accounts set attempted_at = now()
      where address in (
        select address from pipeline_accounts
        where listed_at >= (select max(listed_at) from pipeline_accounts) - interval '10 minutes'
          and (refreshed_at is null or refreshed_at < now() - interval '6 hours')
          and (attempted_at is null or attempted_at < now() - interval '10 minutes')
        order by refreshed_at nulls first limit 60 for update skip locked)
      returning address`;
    const hl = new PacedInfo(900);
    let refreshed = 0;
    let failed = 0;
    for (const { address } of claimed as { address: string }[]) {
      if (this.now() > deadlineMs - 10_000) break;
      try {
        const portfolio = await hl.post<unknown>({ type: "portfolio", user: address });
        parsePortfolio(portfolio); // reject a malformed response now, not at selection
        const fills = await hl.post<Fill[]>(
          { type: "userFillsByTime", user: address, startTime: this.now() - 30 * 24 * HOUR, aggregateByTime: true },
          20,
          (f) => f.length,
        );
        const { tradeCount, makerShare } = fillStats(fills, this.now());
        await sql`
          update pipeline_accounts set portfolio = ${portfolio}::jsonb, trade_count = ${tradeCount}, maker_share = ${makerShare},
            refreshed_at = now(), error = null
          where address = ${address}`;
        refreshed++;
      } catch (e) {
        failed++;
        await sql`update pipeline_accounts set error = ${(e as Error).message} where address = ${address}`;
      }
    }
    log("pipeline refreshed", { discovered, claimed: claimed.length, refreshed, failed });
    return { discovered, refreshed, failed };
  }

  async status() {
    const { sql } = this.o;
    const [counts] = await sql`
      select count(*)::int as listed,
        count(*) filter (where refreshed_at > now() - interval '12 hours')::int as fresh,
        count(*) filter (where error is not null)::int as errors,
        max(listed_at) as listed_at
      from pipeline_accounts where listed_at >= (select max(listed_at) from pipeline_accounts) - interval '10 minutes'`;
    const runs = await sql`
      select id, started_at, finished_at, status, accounts, configuration_hash, error, review -> 'manifest' as manifest
      from selection_runs order by started_at desc limit 10`;
    const [active] = await sql`select hash, activated_at, configuration -> 'sources' as sources from configurations where status = 'active'`;
    // The latest run's finalists, funnel and per-candidate AI verdicts (dashboard).
    const [latest] = await sql`select id, finalists, review -> 'summary' as summary from selection_runs order by started_at desc limit 1`;
    return { accounts: counts, selections: runs, active: active ?? null, latest: latest ?? null };
  }

  // Runs a selection when one is due (or `force`) and enough accounts are fresh.
  async select(force = false): Promise<{ id?: number; status: string; reason?: string }> {
    const { sql, log } = this.o;
    // A run killed mid-way (function timeout) would block its slot forever.
    await sql`update selection_runs set status = 'failed', error = 'did not finish', finished_at = now()
      where status = 'running' and started_at < now() - interval '20 minutes'`;
    const runs = await sql`select started_at, status from selection_runs where started_at > now() - interval '2 days'`;
    if (!force && !selectionDue(this.now(), runs.map((r: { started_at: Date; status: string }) => ({ startedAt: r.started_at.getTime(), status: r.status }))))
      return { status: "not due" };
    const rows = (await sql`
      select address, kind, account_value, closed, portfolio, trade_count, maker_share from pipeline_accounts
      where listed_at >= (select max(listed_at) from pipeline_accounts) - interval '10 minutes'`) as AccountRow[];
    const fresh = rows.filter((r) => r.portfolio !== null);
    if (!force && (rows.length === 0 || fresh.length / rows.length < 0.95)) return { status: "waiting", reason: `${fresh.length}/${rows.length} accounts refreshed` };

    const [{ id }] = await sql`insert into selection_runs (started_at, status, accounts) values (${new Date(this.now())}, 'running', ${fresh.length}) returning id`;
    try {
      const outcome = await this.review(id as number, fresh);
      return { id, ...outcome };
    } catch (e) {
      log("selection failed", { id, error: (e as Error).message });
      await sql`update selection_runs set status = 'failed', error = ${(e as Error).message}, finished_at = now() where id = ${id}`;
      return { id, status: "failed", reason: (e as Error).message };
    }
  }

  private async review(id: number, rows: AccountRow[]): Promise<{ status: string; reason?: string }> {
    const { sql, log, policy } = this.o;
    const inputs: ScoreInput[] = rows.map((r) => ({
      address: r.address,
      kind: r.kind,
      accountValue: r.account_value,
      closed: r.closed,
      ...parsePortfolio(r.portfolio),
      history: null,
      tradeCount: r.trade_count,
      makerShare: r.maker_share,
    }));
    // 15, not Score's default 25: the committee's request must stay under its 105 KB budget
    // (shared/src/committee-evidence.ts), at up to ~4 KB per finalist plus the pairs.
    const result = scoreCandidates(inputs, { finalists: REVIEW_FINALISTS });
    const score = toFrameCandidates(result);
    const byAddress = new Map(result.candidates.map((c) => [c.address, c]));
    const finalists = result.finalists.map((address) => ({ address, kind: byAddress.get(address)?.kind, score: byAddress.get(address)?.score, rank: byAddress.get(address)?.rank }));
    const funnel = result.funnel;
    await sql`update selection_runs set finalists = ${{ finalists, funnel }}::jsonb where id = ${id}`;
    if (score.candidates.length === 0) throw new Error(`no frame candidates (${result.finalists.length} finalists)`);

    // Live positions and equity of each finalist (the review's evidence and the leverage check).
    type State = Parameters<typeof positionsFromStates>[0][number] & { marginSummary: { accountValue: string } };
    const hl = new PacedInfo(600);
    const positions = new Map<string, LivePosition[]>();
    const equity = new Map<string, number>();
    for (const address of score.addresses) {
      const states = await Promise.all(ELIGIBLE_DEXES.map((dex) => hl.post<State>({ type: "clearinghouseState", user: address, ...(dex ? { dex } : {}) }, 2)));
      positions.set(address.toLowerCase(), positionsFromStates(states));
      equity.set(address.toLowerCase(), states.reduce((sum, s) => sum + Number(s.marginSummary.accountValue), 0));
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

import { SQL } from "bun";
import { runAtMs, type Controls, type EquityPoint, type ExecutorStore, type RunRecord, type RunSummary } from "./store";

// Every query gets a deadline so a dead database fails a run instead of hanging it
// (and with it the run queue and the kill switch).
const QUERY_TIMEOUT_MS = 10_000;
const deadline = <T>(query: Promise<T>): Promise<T> =>
  Promise.race([
    query,
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error("database query timed out")), QUERY_TIMEOUT_MS).unref?.()),
  ]);

// executor_reports / executor_runs / executor_controls
// (supabase/migrations/20261006120000_cre_mirror.sql).
export class PostgresStore implements ExecutorStore {
  constructor(private readonly sql: SQL) {}

  async claimReport(id: string): Promise<boolean> {
    const rows = await deadline(this.sql`
      insert into executor_reports (report_id) values (${id})
      on conflict (report_id) do nothing
      returning report_id`);
    return rows.length === 1;
  }

  async saveRun(run: RunRecord): Promise<void> {
    // Plain JSON values (bigints as strings); Bun's SQL client encodes objects for jsonb.
    // Passing a JSON string instead would store a jsonb string scalar.
    const json = (v: unknown) =>
      v === undefined ? null : JSON.parse(JSON.stringify(v, (_, x) => (typeof x === "bigint" ? x.toString() : x)));
    await deadline(this.sql`
      insert into executor_runs
        (id, run_id, kind, status, dry_run, started_at, finished_at, equity_usd, plan, results, error, envelope)
      values (
        ${run.id}, ${run.runId}, ${run.kind}, ${run.status}, ${run.dryRun},
        ${new Date(run.startedAt)}, ${new Date(run.finishedAt)}, ${run.equityUsd ?? null},
        ${json(run.plan)}::jsonb, ${json(run.results)}::jsonb, ${run.error ?? null}, ${json(run.envelope)}::jsonb
      )
      on conflict (id) do update set
        status = excluded.status, finished_at = excluded.finished_at, equity_usd = excluded.equity_usd,
        plan = excluded.plan, results = excluded.results, error = excluded.error`);
  }

  async recentRuns(limit: number): Promise<RunRecord[]> {
    const rows = await deadline(this.sql`
      select * from executor_runs order by started_at desc limit ${limit}`);
    return rows.map(
      (r: Record<string, unknown>): RunRecord => ({
        id: r.id as string,
        runId: r.run_id as string,
        kind: r.kind as RunRecord["kind"],
        status: r.status as RunRecord["status"],
        dryRun: r.dry_run as boolean,
        startedAt: (r.started_at as Date).getTime(),
        finishedAt: (r.finished_at as Date).getTime(),
        equityUsd: (r.equity_usd as number | null) ?? undefined,
        plan: (r.plan as RunRecord["plan"]) ?? undefined,
        results: (r.results as RunRecord["results"]) ?? undefined,
        error: (r.error as string | null) ?? undefined,
        envelope: r.envelope ?? undefined,
      }),
    );
  }

  async recentRunSummaries(limit: number): Promise<RunSummary[]> {
    const rows = await deadline(this.sql`
      select id, run_id, kind, status, dry_run, started_at, finished_at, equity_usd, error,
             coalesce(jsonb_array_length(plan -> 'orders'), 0) as orders
      from executor_runs order by started_at desc limit ${limit}`);
    return rows.map(
      (r: Record<string, unknown>): RunSummary => ({
        id: r.id as string,
        runId: r.run_id as string,
        kind: r.kind as RunRecord["kind"],
        status: r.status as RunRecord["status"],
        dryRun: r.dry_run as boolean,
        startedAt: (r.started_at as Date).getTime(),
        finishedAt: (r.finished_at as Date).getTime(),
        equityUsd: (r.equity_usd as number | null) ?? undefined,
        error: (r.error as string | null) ?? undefined,
        orders: Number(r.orders),
      }),
    );
  }

  async equityCurve(): Promise<EquityPoint[]> {
    const rows = await deadline(this.sql`
      select run_id, started_at, equity_usd, dry_run from executor_runs
      where kind = 'report' and status = 'executed' and equity_usd is not null
      order by started_at`);
    return rows
      .map((r: Record<string, unknown>): EquityPoint => ({
        t: runAtMs({ runId: r.run_id as string, startedAt: (r.started_at as Date).getTime() }),
        equityUsd: Number(r.equity_usd),
        dryRun: r.dry_run as boolean,
      }))
      .sort((a: EquityPoint, b: EquityPoint) => a.t - b.t);
  }

  async getControls(): Promise<Controls> {
    const [r] = await deadline(this.sql`select paused, updated_at, updated_by from executor_controls where id = 1`);
    if (!r) return { paused: false, updatedAt: 0, updatedBy: "default" };
    return { paused: r.paused, updatedAt: (r.updated_at as Date).getTime(), updatedBy: r.updated_by };
  }

  async setControls(c: Controls): Promise<void> {
    await deadline(this.sql`
      insert into executor_controls (id, paused, updated_at, updated_by)
      values (1, ${c.paused}, ${new Date(c.updatedAt)}, ${c.updatedBy})
      on conflict (id) do update set paused = excluded.paused, updated_at = excluded.updated_at, updated_by = excluded.updated_by`);
  }
}

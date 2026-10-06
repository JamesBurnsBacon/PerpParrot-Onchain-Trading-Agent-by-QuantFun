import { SQL } from "bun";
import type { Controls, ExecutorStore, RunRecord } from "./store";

// executor_reports / executor_runs / executor_controls
// (supabase/migrations/20261006120000_cre_mirror.sql).
export class PostgresStore implements ExecutorStore {
  constructor(private readonly sql: SQL) {}

  async claimReport(id: string): Promise<boolean> {
    const rows = await this.sql`
      insert into executor_reports (report_id) values (${id})
      on conflict (report_id) do nothing
      returning report_id`;
    return rows.length === 1;
  }

  async saveRun(run: RunRecord): Promise<void> {
    // Plain JSON values (bigints as strings); Bun's SQL client encodes objects for jsonb.
    // Passing a JSON string instead would store a jsonb string scalar.
    const json = (v: unknown) =>
      v === undefined ? null : JSON.parse(JSON.stringify(v, (_, x) => (typeof x === "bigint" ? x.toString() : x)));
    await this.sql`
      insert into executor_runs
        (id, run_id, kind, status, dry_run, started_at, finished_at, equity_usd, plan, results, error, envelope)
      values (
        ${run.id}, ${run.runId}, ${run.kind}, ${run.status}, ${run.dryRun},
        ${new Date(run.startedAt)}, ${new Date(run.finishedAt)}, ${run.equityUsd ?? null},
        ${json(run.plan)}::jsonb, ${json(run.results)}::jsonb, ${run.error ?? null}, ${json(run.envelope)}::jsonb
      )
      on conflict (id) do update set
        status = excluded.status, finished_at = excluded.finished_at, equity_usd = excluded.equity_usd,
        plan = excluded.plan, results = excluded.results, error = excluded.error`;
  }

  async recentRuns(limit: number): Promise<RunRecord[]> {
    const rows = await this.sql`
      select * from executor_runs order by started_at desc limit ${limit}`;
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

  async getControls(): Promise<Controls> {
    const [r] = await this.sql`select paused, updated_at, updated_by from executor_controls where id = 1`;
    if (!r) return { paused: false, updatedAt: 0, updatedBy: "default" };
    return { paused: r.paused, updatedAt: (r.updated_at as Date).getTime(), updatedBy: r.updated_by };
  }

  async setControls(c: Controls): Promise<void> {
    await this.sql`
      insert into executor_controls (id, paused, updated_at, updated_by)
      values (1, ${c.paused}, ${new Date(c.updatedAt)}, ${c.updatedBy})
      on conflict (id) do update set paused = excluded.paused, updated_at = excluded.updated_at, updated_by = excluded.updated_by`;
  }
}

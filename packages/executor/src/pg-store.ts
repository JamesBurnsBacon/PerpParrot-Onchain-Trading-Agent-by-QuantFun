import { SQL } from "bun";
import type { Controls, ExecutorStore, OrderBatch, RunRecord } from "./store";
import type { OrderResult } from "./exchange";
import type { PlannedOrder } from "./planner";
import type { Hex } from "viem";

// Every query gets a deadline so a dead database fails a run instead of hanging it
// (and with it the run queue and the kill switch).
const QUERY_TIMEOUT_MS = 10_000;
const deadline = <T>(query: Promise<T>): Promise<T> =>
  Promise.race([
    query,
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error("database query timed out")), QUERY_TIMEOUT_MS).unref?.()),
  ]);

// Bun.SQL treats a JavaScript string bound to a jsonb expression as a JSON
// string scalar. Bind parsed JSON values instead so Postgres stores the
// intended arrays/objects (and array checks and readers see the right shape).
const jsonValue = (value: unknown): unknown =>
  value === undefined ? null : JSON.parse(JSON.stringify(value, (_, item) => (typeof item === "bigint" ? item.toString() : item)));

// executor_reports / executor_runs / executor_controls / executor_order_batches
// (supabase/migrations/20261006120000_cre_mirror.sql and 20261006180000_executor_order_journal.sql).
export class PostgresStore implements ExecutorStore {
  constructor(private readonly sql: SQL) {}

  async withExecutionLock<T>(fn: () => Promise<T>): Promise<T> {
    const connection = await this.sql.reserve({ signal: AbortSignal.timeout(QUERY_TIMEOUT_MS) });
    try {
      return await connection.begin(async (tx) => {
        const [row] = await deadline(tx`select pg_try_advisory_xact_lock(1347442768, 1163414851) as locked`);
        if (row?.locked !== true) throw new Error("another executor instance owns the trading lock");
        return await fn();
      });
    } finally {
      await connection.release();
    }
  }

  async beginOrderBatch(batch: Omit<OrderBatch, "state" | "results" | "resolution">): Promise<void> {
    await deadline(this.sql`
      insert into executor_order_batches (id, report_id, created_at, kind, details, orders, cloids, state)
      values (${batch.id}, ${batch.reportId}, ${new Date(batch.createdAt)}, ${batch.kind}, ${jsonValue(batch.details)}::jsonb, ${jsonValue(batch.orders)}::jsonb, ${jsonValue(batch.cloids)}::jsonb, 'dispatching')`);
  }

  async finishOrderBatch(id: string, results: OrderResult[]): Promise<void> {
    const state = results.some((result) => result.status === "unknown") ? "uncertain" : "settled";
    const rows = await deadline(this.sql`
      update executor_order_batches set state = ${state}, results = ${jsonValue(results)}::jsonb
      where id = ${id} and state = 'dispatching' returning id`);
    if (rows.length !== 1) throw new Error("order batch is not dispatching");
  }

  async unresolvedOrderBatches(): Promise<OrderBatch[]> {
    const rows = await deadline(this.sql`
      select id, report_id, created_at, kind, details, orders, cloids, state, results
      from executor_order_batches where state in ('dispatching', 'uncertain') order by created_at`);
    return rows.map((r: Record<string, unknown>) => ({
      id: r.id as string,
      reportId: r.report_id as string,
      createdAt: (r.created_at as Date).getTime(),
      orders: r.orders as PlannedOrder[],
      kind: r.kind as OrderBatch["kind"],
      details: (r.details as OrderBatch["details"]) ?? undefined,
      cloids: r.cloids as Hex[],
      state: r.state as OrderBatch["state"],
      results: (r.results as OrderResult[] | null) ?? undefined,
    }));
  }

  async reconcileOrderBatch(id: string, by: string, evidence: string, at: number): Promise<void> {
    const rows = await deadline(this.sql`
      update executor_order_batches set state = 'reconciled', resolved_by = ${by}, resolution = ${evidence}, resolved_at = ${new Date(at)}
      where id = ${id} and state in ('dispatching', 'uncertain') returning id`);
    if (rows.length !== 1) throw new Error("order batch is not unresolved");
  }

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
    await deadline(this.sql`
      insert into executor_runs
        (id, run_id, kind, status, dry_run, started_at, finished_at, equity_usd, plan, results, error, envelope)
      values (
        ${run.id}, ${run.runId}, ${run.kind}, ${run.status}, ${run.dryRun},
        ${new Date(run.startedAt)}, ${new Date(run.finishedAt)}, ${run.equityUsd ?? null},
        ${jsonValue(run.plan)}::jsonb, ${jsonValue(run.results)}::jsonb, ${run.error ?? null}, ${jsonValue(run.envelope)}::jsonb
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

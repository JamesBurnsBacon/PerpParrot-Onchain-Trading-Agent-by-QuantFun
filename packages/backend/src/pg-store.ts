import { SQL } from "bun";
import type { EligibilityState, EligibilityStore } from "./eligibility";
import type { PaperPoint, PaperState, PaperStore } from "./paper/service";
import { keccakUtf8, type SnapshotStore } from "./snapshot";

// cre_snapshots (supabase/migrations/20261006120000_cre_mirror.sql). The body is
// stored as text so every reader gets the exact bytes that were first written.
export class PostgresSnapshotStore implements SnapshotStore {
  constructor(private readonly sql: SQL) {}

  async get(runAt: number): Promise<string | undefined> {
    const rows = await this.sql`select body from cre_snapshots where run_at = ${runAt}`;
    return rows[0]?.body;
  }

  async putIfAbsent(runAt: number, json: string): Promise<string> {
    const configurationHash = (JSON.parse(json) as { configuration: { configurationHash: string } }).configuration.configurationHash;
    await this.sql`
      insert into cre_snapshots (run_at, snapshot_hash, configuration_hash, body)
      values (${runAt}, ${keccakUtf8(json)}, ${configurationHash}, ${json})
      on conflict (run_at) do nothing`;
    // Another instance may have written first; serve whatever is stored.
    return (await this.get(runAt))!;
  }
}

// cre_eligibility: the eligible-asset list and when it was last checked (one row).
export class PostgresEligibilityStore implements EligibilityStore {
  constructor(private readonly sql: SQL) {}

  async load(): Promise<EligibilityState | undefined> {
    const [row] = await this.sql`select assets, checked_at, refusing_since from cre_eligibility where id = 1`;
    if (!row) return undefined;
    return {
      assets: row.assets as string[],
      checkedAt: (row.checked_at as Date).getTime(),
      ...(row.refusing_since ? { refusingSince: (row.refusing_since as Date).getTime() } : {}),
    };
  }

  async save(state: EligibilityState): Promise<void> {
    await this.sql`
      insert into cre_eligibility (id, assets, checked_at, refusing_since)
      values (1, ${state.assets}::jsonb, ${new Date(state.checkedAt)}, ${state.refusingSince ? new Date(state.refusingSince) : null})
      on conflict (id) do update set
        assets = excluded.assets, checked_at = excluded.checked_at, refusing_since = excluded.refusing_since`;
  }
}

// paper_books / paper_points (README §4.10): book state and equity curves.
export class PostgresPaperStore implements PaperStore {
  constructor(private readonly sql: SQL) {}

  async load(): Promise<PaperState | undefined> {
    const [row] = await this.sql`select state from paper_state where id = 1`;
    return row ? (row.state as PaperState) : undefined;
  }

  async save(state: PaperState, points: PaperPoint[]): Promise<boolean> {
    return this.sql.begin(async (tx) => {
      // Only forward: a second instance stepping the same run from the same state writes nothing.
      const written = await tx`
        insert into paper_state (id, state, last_run_at) values (1, ${JSON.parse(JSON.stringify(state))}::jsonb, ${state.lastRunAt})
        on conflict (id) do update set state = excluded.state, last_run_at = excluded.last_run_at, updated_at = now()
        where paper_state.last_run_at < excluded.last_run_at
        returning id`;
      if (!written.length) return false;
      for (const p of points) {
        await tx`
          insert into paper_points (book_id, t, equity_usd) values (${p.bookId}, ${p.t}, ${p.equityUsd})
          on conflict (book_id, t) do nothing`;
      }
      return true;
    });
  }

  async points(sinceT: number): Promise<PaperPoint[]> {
    const rows = await this.sql`select book_id, t, equity_usd from paper_points where t >= ${sinceT} order by t`;
    return rows.map((r: Record<string, unknown>) => ({ bookId: r.book_id as string, t: Number(r.t), equityUsd: Number(r.equity_usd) }));
  }
}

// dashboard_artifacts: results other modules publish for the dashboard (shared/dashboard.ts).
export const readPostgresArtifact = (sql: SQL) => async (name: string): Promise<unknown | undefined> => {
  const [row] = await sql`select body from dashboard_artifacts where name = ${name}`;
  return row?.body;
};

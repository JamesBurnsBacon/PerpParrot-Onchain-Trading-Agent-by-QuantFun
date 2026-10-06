import { SQL } from "bun";
import type { EligibilityState, EligibilityStore } from "./eligibility";
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
    const [row] = await this.sql`select assets, checked_at from cre_eligibility where id = 1`;
    return row ? { assets: row.assets as string[], checkedAt: (row.checked_at as Date).getTime() } : undefined;
  }

  async save(state: EligibilityState): Promise<void> {
    await this.sql`
      insert into cre_eligibility (id, assets, checked_at) values (1, ${state.assets}::jsonb, ${new Date(state.checkedAt)})
      on conflict (id) do update set assets = excluded.assets, checked_at = excluded.checked_at`;
  }
}

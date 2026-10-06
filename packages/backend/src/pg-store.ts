import { SQL } from "bun";
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

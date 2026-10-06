import { isDeepStrictEqual } from "node:util";
import type { DbRow, Snapshot, Table } from "./sync-snapshot";

export interface IngestRemote {
  ensureBucket(): Promise<void>;
  putObject(path: string, bytes: Uint8Array): Promise<void>;
  insert(table: Table, rows: DbRow[], conflict: string): Promise<void>;
  read(table: Table, runId: string): Promise<DbRow[]>;
  finish(runId: string): Promise<void>;
}

function verifyRows(expected: DbRow[], actual: DbRow[], key: string) {
  const indexed = new Map(actual.map((row) => [row[key], row]));
  if (actual.length !== expected.length || indexed.size !== expected.length) throw new Error("Remote row count mismatch");
  for (const row of expected) {
    const other = indexed.get(row[key]);
    if (!other || Object.entries(row).some(([name, value]) => !isDeepStrictEqual(value, other[name]))) {
      throw new Error(`Remote ${key} row content mismatch`);
    }
  }
}

export async function syncSnapshot(snapshot: Snapshot, remote: IngestRemote, log: (s: string) => void = () => {}) {
  const { runId, run } = snapshot;
  const previous = (await remote.read("ingest_runs", runId))[0];
  if (previous && (previous.manifest_sha256 !== run.manifest_sha256 || previous.archive_path !== run.archive_path)) {
    throw new Error("Run ID already exists with different content; refusing to overwrite");
  }
  await remote.ensureBucket();
  await remote.insert("ingest_runs", [{ ...run, sync_status: "uploading" }], "run_id");
  for (const object of snapshot.objects) {
    log(`storage: ${object.path}`);
    await remote.putObject(object.path, object.bytes);
  }
  for (const [table, rows, key, batchSize] of [
    ["ingest_sources", snapshot.sourceRows, "name", 2],
    ["ingest_candidates", snapshot.candidateRows, "address", 500],
    ["ingest_portfolios", snapshot.portfolioRows, "address", 10],
  ] as const) {
    for (let i = 0; i < rows.length; i += batchSize) {
      await remote.insert(table, rows.slice(i, i + batchSize), `run_id,${key}`);
      log(`${table}: ${Math.min(i + batchSize, rows.length)}/${rows.length}`);
    }
    verifyRows(rows, await remote.read(table, runId), key);
  }
  verifyRows([run], await remote.read("ingest_runs", runId), "run_id");
  await remote.finish(runId);
  const final = (await remote.read("ingest_runs", runId))[0];
  if (final?.sync_status !== "complete") throw new Error("Remote completion was not confirmed");
  return {
    marker: "SUPABASE_SYNC_OK", runId, candidates: snapshot.candidateRows.length,
    portfolios: snapshot.portfolioRows.length, objects: snapshot.objects.length,
    readbackVerified: true, resumed: !!previous,
  };
}

import { describe, expect, test } from "bun:test";
import { syncSnapshot, type IngestRemote } from "../src/ingest/sync";
import { connectionConfig, PROJECT_URL, SupabaseRemote } from "../src/ingest/supabase";
import type { DbRow, Snapshot, Table } from "../src/ingest/sync-snapshot";

function fixture(): Snapshot {
  return {
    runId: "test-run",
    run: { run_id: "test-run", manifest_sha256: "a".repeat(64), archive_path: "runs/test-run/archive.json.gz" },
    candidateRows: [{ run_id: "test-run", address: "0x1", account_value_or_tvl_usd: "10000.000000000000001", candidate: { a: "1", b: "2" } }],
    portfolioRows: [{ run_id: "test-run", address: "0x1", portfolio: [["month", { pnlHistory: [[1, "-3.123456789123456789"]] }]] }],
    sourceRows: [{ run_id: "test-run", name: "leaderboard", source: { fetchedAt: "original-time" } }],
    objects: [{ path: "archive.json.gz", bytes: new Uint8Array([1, 2, 3]) }],
  };
}

class MemoryRemote implements IngestRemote {
  tables = new Map<Table, DbRow[]>();
  failPortfolios = false;
  corrupt = false;
  finished = 0;
  async ensureBucket() {}
  async putObject() {}
  async insert(table: Table, rows: DbRow[], conflict: string) {
    if (table === "ingest_portfolios" && this.failPortfolios) throw new Error("upload interrupted");
    const existing = this.tables.get(table) ?? [];
    for (const row of rows) {
      if (!existing.some((other) => conflict.split(",").every((key) => other[key] === row[key]))) existing.push(structuredClone(row));
    }
    this.tables.set(table, existing);
  }
  async read(table: Table, runId: string) {
    const rows = structuredClone((this.tables.get(table) ?? []).filter((r) => r.run_id === runId));
    if (this.corrupt && table === "ingest_candidates" && rows[0]) rows[0].account_value_or_tvl_usd = "rounded";
    return rows;
  }
  async finish(runId: string) {
    this.finished++;
    this.tables.get("ingest_runs")!.find((r) => r.run_id === runId)!.sync_status = "complete";
  }
}

describe("Supabase snapshot import", () => {
  test("imports, reads back exact decimals and is idempotent", async () => {
    const remote = new MemoryRemote();
    expect((await syncSnapshot(fixture(), remote)).marker).toBe("SUPABASE_SYNC_OK");
    expect((await syncSnapshot(fixture(), remote)).resumed).toBe(true);
    expect(remote.tables.get("ingest_candidates")).toHaveLength(1);
    expect(remote.tables.get("ingest_portfolios")).toHaveLength(1);
  });
  test("interrupted writes stay uploading and resume without duplicating earlier rows", async () => {
    const remote = new MemoryRemote();
    remote.failPortfolios = true;
    await expect(syncSnapshot(fixture(), remote)).rejects.toThrow("interrupted");
    expect(remote.tables.get("ingest_runs")![0].sync_status).toBe("uploading");
    expect(remote.finished).toBe(0);
    remote.failPortfolios = false;
    await syncSnapshot(fixture(), remote);
    expect(remote.tables.get("ingest_candidates")).toHaveLength(1);
  });
  test("changed content under the same run ID cannot overwrite existing snapshots", async () => {
    const remote = new MemoryRemote();
    await syncSnapshot(fixture(), remote);
    const changed = fixture(); changed.run.archive_path = "different";
    await expect(syncSnapshot(changed, remote)).rejects.toThrow("refusing to overwrite");
    expect(remote.finished).toBe(1);
  });
  test("readback corruption prevents publication", async () => {
    const remote = new MemoryRemote(); remote.corrupt = true;
    await expect(syncSnapshot(fixture(), remote)).rejects.toThrow("mismatch");
    expect(remote.finished).toBe(0);
  });
});

describe("Supabase connection and transport", () => {
  // Construct a non-credential test value without committing a secret-shaped literal.
  const key = ["sb", "secret", "test_only_not_a_real_credential"].join("_");
  test("rejects wrong project and non-secret keys without revealing them", () => {
    expect(() => connectionConfig({ SUPABASE_URL: "https://another.supabase.co", SUPABASE_SECRET_KEY: key })).toThrow("confirmed");
    expect(() => connectionConfig({ SUPABASE_URL: PROJECT_URL, SUPABASE_SECRET_KEY: "sb_publishable_private_example" })).toThrow("Secret key");
    expect(connectionConfig({ SUPABASE_URL: PROJECT_URL, SUPABASE_SECRET_KEY: key }).url).toBe(PROJECT_URL);
  });
  test("SDK sends secret only to the confirmed HTTPS project in apikey, without Bearer", async () => {
    let requests = 0;
    const remote = new SupabaseRemote({ url: PROJECT_URL, key }, async (url, init) => {
      requests++;
      expect(new URL(String(url)).origin).toBe(PROJECT_URL);
      const headers = new Headers(init?.headers);
      expect(headers.get("apikey")).toBe(key);
      expect(headers.get("authorization")).toBeNull();
      expect(init?.redirect).toBe("error");
      return Response.json([]);
    });
    expect(await remote.read("ingest_runs", "test")).toEqual([]);
    expect(requests).toBe(1);
  });
  test("remote errors never echo response-body secrets", async () => {
    const remote = new SupabaseRemote({ url: PROJECT_URL, key }, async () => Response.json({ code: "42501", message: key }, { status: 403 }));
    try { await remote.read("ingest_runs", "test"); throw new Error("unexpected success"); }
    catch (e) { expect(String(e)).toContain("42501"); expect(String(e)).not.toContain(key); }
  });
  test("refuses a public storage bucket", async () => {
    const remote = new SupabaseRemote({ url: PROJECT_URL, key }, async () => Response.json({ id: "perpparrot-ingest", public: true }));
    await expect(remote.ensureBucket()).rejects.toThrow("public");
  });
  test("existing immutable storage objects must have matching content", async () => {
    const remote = new SupabaseRemote({ url: PROJECT_URL, key }, async (_url, init) => init?.method === "POST"
      ? Response.json({ statusCode: "409", error: "Duplicate", message: "The resource already exists" }, { status: 409 })
      : new Response(new Uint8Array([9, 9, 9])));
    await expect(remote.putObject("test.json.gz", new Uint8Array([1, 2, 3]))).rejects.toThrow("hash mismatch");
  });
});

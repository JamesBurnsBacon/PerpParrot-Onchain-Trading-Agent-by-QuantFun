import { parseArgs } from "node:util";
import { resolve } from "node:path";
import { loadSnapshot } from "./sync-snapshot";
import { syncSnapshot } from "./sync";
import { connectionConfig, PROJECT_REF, SupabaseRemote } from "./supabase";

const { values } = parseArgs({
  args: process.argv.slice(2), strict: true, allowPositionals: false,
  options: {
    out: { type: "string", default: "./data/ingest" },
    "run-id": { type: "string" },
    "dry-run": { type: "boolean", default: false },
    help: { type: "boolean", short: "h" },
  },
});

if (values.help) {
  console.log("Usage: bun run ingest:sync [--out ./data/ingest] [--run-id ID] [--dry-run]\nImports an existing local snapshot into the confirmed PerpParrot Supabase project. No Hyperliquid queries or trades.\nRun the SQL migration first. SUPABASE_URL and SUPABASE_SECRET_KEY are read from the backend .env.");
} else {
  try {
    const snapshot = await loadSnapshot(resolve(values.out!), values["run-id"]);
    if (values["dry-run"]) {
      console.log(JSON.stringify({
        marker: "SUPABASE_SYNC_DRY_RUN", projectRef: PROJECT_REF, runId: snapshot.runId,
        candidates: snapshot.candidateRows.length, portfolios: snapshot.portfolioRows.length,
        objects: snapshot.objects.map((o) => ({ path: o.path, compressedBytes: o.bytes.length })),
        remoteRequests: 0,
      }, null, 2));
    } else {
      const remote = new SupabaseRemote(connectionConfig(process.env));
      const result = await syncSnapshot(snapshot, remote, console.error);
      console.log(JSON.stringify({ ...result, projectRef: PROJECT_REF }, null, 2));
    }
  } catch (error) {
    console.error(`SUPABASE_SYNC_FAILED: ${error instanceof Error ? error.message : "Unknown failure"}`);
    process.exitCode = 1;
  }
}

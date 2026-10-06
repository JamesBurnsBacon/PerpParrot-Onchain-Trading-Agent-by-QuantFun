import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { ingest } from "./pipeline";
import { connectionConfig, SupabaseRemote } from "./supabase";
import { loadSnapshot } from "./sync-snapshot";
import { syncSnapshot } from "./sync";

const { values } = parseArgs({
  args: process.argv.slice(2), strict: true, allowPositionals: false,
  options: {
    limit: { type: "string", default: "200" },
    out: { type: "string", default: "./data/ingest" },
    "cache-hours": { type: "string", default: "3" },
    refresh: { type: "boolean", default: false },
    supabase: { type: "boolean", default: false },
    help: { type: "boolean", short: "h" },
  },
});

if (values.help) {
  console.log("Usage: bun run ingest [--limit 200] [--out ./data/ingest] [--cache-hours 3] [--refresh] [--supabase]\nRead-only Hyperliquid + HyperEVM ingestion. No wallet, orders or scoring.\nAll output paths in manifests are relative to --out. Fresh portfolio history is fetched on every run.\n--supabase also imports and verifies the snapshot in PerpParrot; requires the backend Secret key.");
} else {
  const limit = Number(values.limit);
  const cacheHours = Number(values["cache-hours"]);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) throw new Error("--limit must be an integer from 1 to 500");
  if (!Number.isFinite(cacheHours) || cacheHours <= 0 || cacheHours > 24) throw new Error("--cache-hours must be >0 and <=24");
  try {
    const output = resolve(values.out!);
    const remote = values.supabase ? new SupabaseRemote(connectionConfig(process.env)) : null;
    const result = await ingest({ output, limit, cacheHours, refresh: values.refresh!, onProgress: console.error });
    const supabase = remote ? await syncSnapshot(await loadSnapshot(output, result.runId), remote, console.error) : null;
    console.log(JSON.stringify({ marker: result.status === "complete" ? "INGEST_OK" : "INGEST_PARTIAL", output, ...result, supabase }, null, 2));
    if (result.status !== "complete") process.exitCode = 1;
  } catch (error) {
    console.error(`INGEST_FAILED: ${(error as Error).message}`);
    process.exitCode = 1;
  }
}

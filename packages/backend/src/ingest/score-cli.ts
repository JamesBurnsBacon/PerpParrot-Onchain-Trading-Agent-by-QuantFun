import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { execFileSync } from "node:child_process";
import { scoreCandidates, toFrameCandidates } from "../score";
import { buildScoreInputs, readScoreSnapshot, type ScoreSnapshot } from "./score-loader";
import { loadSnapshot } from "./sync-snapshot";
import { connectionConfig, SupabaseRemote } from "./supabase";

export async function scoreStored(args: string[]) {
  const { values } = parseArgs({ args, strict: true, allowPositionals: false, options: {
    local: { type: "string", multiple: true }, supabase: { type: "boolean" },
    "run-id": { type: "string" }, "history-run": { type: "string", multiple: true },
    "evidence-dir": { type: "string" }, preview: { type: "boolean", default: false },
    out: { type: "string" }, help: { type: "boolean" },
  } });
  if (values.help) {
    console.log("Usage: bun run score:stored --run-id RUN --out NEW_DIRECTORY [--local INGEST_ROOT (repeatable) | --supabase --history-run RUN (repeatable)] [--evidence-dir DIRECTORY] [--preview]\nRead-only stored data -> ScoreInput[] -> Score. No collection, fills requests, database writes or scheduling.\nLocal mode verifies raw hashes; scans completed older runs in supplied roots. Supabase mode requires an explicit target run and explicit older run IDs. --preview also allows unknown minTrades, clearly separated from strict results.");
    return;
  }
  if (!values["run-id"] || !values.out) throw new Error("--run-id and --out are required");
  if (Boolean(values.supabase) === Boolean(values.local?.length)) throw new Error("Choose either --local or --supabase");
  if (!values.supabase && values["history-run"]?.length) throw new Error("--history-run is for Supabase mode; local mode scans supplied roots");
  let current: ScoreSnapshot;
  const older: ScoreSnapshot[] = [];
  if (values.supabase) {
    const remote = new SupabaseRemote(connectionConfig(process.env));
    current = await readScoreSnapshot(remote, values["run-id"]);
    for (const runId of values["history-run"] ?? []) older.push(await readScoreSnapshot(remote, runId));
  } else {
    const locations = new Map<string, { root: string; finishedAt: number }>();
    for (const root of [...new Set(values.local!.map(p => resolve(p)))]) {
      for (const runId of await readdir(join(root, "runs"))) {
        const manifest = JSON.parse(await readFile(join(root, "runs", runId, "manifest.json"), "utf8"));
        if (manifest.status !== "complete") continue;
        if (locations.has(runId)) throw new Error("Duplicate local run ID across roots");
        const finishedAt = Date.parse(manifest.finishedAt);
        if (!Number.isFinite(finishedAt)) throw new Error("Invalid local run completion timestamp");
        locations.set(runId, { root, finishedAt });
      }
    }
    const target = locations.get(values["run-id"]);
    if (!target) throw new Error("Requested complete local run not found");
    current = await loadSnapshot(target.root, values["run-id"]);
    for (const [id, source] of locations) {
      if (id !== values["run-id"] && source.finishedAt <= target.finishedAt) older.push(await loadSnapshot(source.root, id));
    }
  }
  const fills = new Map<string, unknown>();
  const evidenceAudit: { address: string; status: string }[] = [];
  if (values["evidence-dir"]) {
    for (const row of current.portfolioRows) {
      const address = String(row.address);
      try {
        const evidence = JSON.parse(await readFile(join(resolve(values["evidence-dir"]), `${address}.fills.json`), "utf8"));
        // Evidence files may contain one request or several overlapping slices.
        const requests: unknown[] = Array.isArray(evidence.request) ? evidence.request : [evidence.request];
        if (evidence.http_status !== 200 || !Array.isArray(evidence.response)
          || requests.length === 0 || requests.some(r => !r || typeof r !== "object" || !("user" in r)
            || typeof r.user !== "string" || r.user.toLowerCase() !== address)) {
          throw new Error("Evidence status, response or address does not match");
        }
        fills.set(address, evidence.response);
        evidenceAudit.push({ address, status: "loaded; counts are lower bounds, not complete lifetime history" });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") evidenceAudit.push({ address, status: "invalid evidence; trade count left unknown" });
      }
    }
  }
  const loaded = buildScoreInputs(current, older, fills);
  const strict = scoreCandidates(loaded.inputs);
  const preview = values.preview ? scoreCandidates(loaded.inputs, { allowUnknown: ["minTrades"] }) : null;
  const unresolvedTrades = strict.candidates.filter(c => c.filters.minTrades === "unknown"
    && Object.entries(c.filters).every(([name, status]) => name === "minTrades" || status === "pass")).length;
  const rankingComplete = loaded.issues.length === 0 && loaded.counts.omitted === 0 && unresolvedTrades === 0;
  const output = resolve(values.out);
  let revision = "unknown";
  try { revision = execFileSync("git", ["rev-parse", "HEAD"], { cwd: import.meta.dir, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim(); } catch { /* packaged without Git */ }
  const report = {
    format: "ingest-score-handoff.v1", generatedAt: new Date().toISOString(), repositoryBaseCommit: revision,
    note: "Loader may include local uncommitted changes. Score is the repository implementation. This is not a full AI review frame or a live source configuration.",
    source: values.supabase ? "supabase-read-only" : "local-verified-archives",
    ...loaded, inputs: undefined, evidenceAudit, rankingComplete, unresolvedTrades,
    strict, preview: preview ? { label: "PREVIEW_ONLY_ALLOW_UNKNOWN_MIN_TRADES", result: preview } : null,
    // Avoid presenting partially evidenced finalists as a complete downstream handoff.
    scoreOwnedFrame: rankingComplete ? toFrameCandidates(strict) : null,
  };
  // Never replace an earlier report, source archive, or evidence directory.
  await mkdir(dirname(output), { recursive: true });
  await mkdir(output);
  await writeFile(join(output, "score-inputs.json"), JSON.stringify(loaded.inputs, null, 2) + "\n", { flag: "wx" });
  await writeFile(join(output, "score-report.json"), JSON.stringify(report, null, 2) + "\n", { flag: "wx" });
  console.log(JSON.stringify({ marker: "INGEST_SCORE_LOADED", output, sourceRun: loaded.sourceRun,
    ...loaded.counts, issues: loaded.issues.length, rankingComplete, unresolvedTrades,
    strictFinalists: strict.finalists.length, previewFinalists: preview?.finalists.length ?? null }));
}

if (import.meta.main) {
  try { await scoreStored(process.argv.slice(2)); }
  catch (error) { console.error(`INGEST_SCORE_FAILED: ${(error as Error).message}`); process.exitCode = 1; }
}

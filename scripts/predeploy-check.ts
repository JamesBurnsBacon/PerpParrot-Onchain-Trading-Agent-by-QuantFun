#!/usr/bin/env bun
// Pre-deploy check (docs/cre/RUNBOOK.md § Deploy): do the mirror config, the frozen
// configuration, both Railway services, the dashboard and Supabase agree? Read-only.
//
//   bun scripts/predeploy-check.ts                                   # repo files only
//   bun scripts/predeploy-check.ts --backend https://… --executor https://… [--dashboard https://…]
//   DATABASE_URL=postgres://… bun scripts/predeploy-check.ts …       # also the Supabase tables
//
// In the CRE deploy Action: --from-config takes the service URLs from the mirror's production
// config (so the deploy stops if those services don't pin the same configuration).
//
// Rehearsal before the freeze (docs/cre/DEPLOY_REHEARSAL.md): --services-only skips the mirror's
// production config, and --configuration <file> compares the services against that file
// instead of packages/backend/frozen/live.json.
//
// Exit code 1 if any check fails. Warnings are things to look at, not blockers.
import { SQL } from "bun";

const args = process.argv.slice(2);
const arg = (name: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1]?.replace(/\/+$/, "") : undefined;
};
const root = new URL("..", import.meta.url).pathname;
const cfg = await Bun.file(`${root}packages/cre-workflows/mirror/config.production.json`).json();
const fromConfig = process.argv.includes("--from-config");
const backend = arg("backend") ?? (fromConfig ? cfg.backendUrl.replace(/\/+$/, "") : undefined);
const executor = arg("executor") ?? (fromConfig ? cfg.executorUrl.replace(/\/reports\/?$/, "") : undefined);
const dashboard = arg("dashboard");
const servicesOnly = args.includes("--services-only");
const configurationPath = arg("configuration") ?? "packages/backend/frozen/live.json";

let failed = 0;
let warned = 0;
const pass = (m: string) => console.log(`  ok    ${m}`);
const fail = (m: string) => (failed++, console.log(`  FAIL  ${m}`));
const warn = (m: string) => (warned++, console.log(`  warn  ${m}`));
const check = (ok: boolean, good: string, bad: string) => (ok ? pass(good) : fail(bad));
const section = (m: string) => console.log(`\n${m}`);

const ZERO = `0x${"0".repeat(64)}`;

const getJson = async (url: string): Promise<{ status: number; body: any; headers: Headers } | undefined> => {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
    const text = await res.text();
    let body: unknown = text;
    try {
      body = JSON.parse(text);
    } catch {}
    return { status: res.status, body, headers: res.headers };
  } catch (e) {
    fail(`${url}: ${(e as Error).message}`);
    return undefined;
  }
};

// 1. Mirror production config.
if (!servicesOnly) {
section("mirror/config.production.json");
check(!/REPLACE/.test(cfg.backendUrl) && cfg.backendUrl.startsWith("https://"), `backendUrl ${cfg.backendUrl}`, `backendUrl is a placeholder or not https: ${cfg.backendUrl}`);
check(
  !/REPLACE/.test(cfg.executorUrl) && cfg.executorUrl.startsWith("https://") && cfg.executorUrl.endsWith("/reports"),
  `executorUrl ${cfg.executorUrl}`,
  `executorUrl must be https://…/reports: ${cfg.executorUrl}`,
);
check(/^0x[0-9a-f]{64}$/.test(cfg.frozenConfigurationHash) && cfg.frozenConfigurationHash !== ZERO, `frozenConfigurationHash ${cfg.frozenConfigurationHash}`, "frozenConfigurationHash is unset (zero): run scripts/freeze.ts --write");
check(cfg.maxSnapshotAgeSeconds <= 120, `maxSnapshotAgeSeconds ${cfg.maxSnapshotAgeSeconds}`, `maxSnapshotAgeSeconds ${cfg.maxSnapshotAgeSeconds} > 120 (600 is for simulation only)`);
check(cfg.spotCheckCount >= 1 && cfg.spotCheckCount <= 4, `spotCheckCount ${cfg.spotCheckCount}`, `spotCheckCount ${cfg.spotCheckCount} outside 1–4 (HTTP budget)`);
check(cfg.schedule === "0 */10 * * * *", "schedule every 10 min", `schedule ${cfg.schedule}`);
if (backend) check(cfg.backendUrl === backend, "backendUrl matches --backend", `backendUrl ${cfg.backendUrl} ≠ --backend ${backend}`);
if (executor) check(cfg.executorUrl === `${executor}/reports`, "executorUrl matches --executor", `executorUrl ${cfg.executorUrl} ≠ ${executor}/reports`);

const secrets = await Bun.file(`${root}packages/cre-workflows/secrets.yaml`).text();
check(/mirrorSamplingKey:/.test(secrets), "secrets.yaml declares mirrorSamplingKey (create it in the Vault DON: RUNBOOK)", "secrets.yaml lacks mirrorSamplingKey");
}

// 2. Frozen configuration the snapshot service will serve; the services must pin its hash.
section(configurationPath);
const liveFile = Bun.file(`${root}${configurationPath}`);
let account: string | undefined;
let expectedHash: string = cfg.frozenConfigurationHash;
if (await liveFile.exists()) {
  const live = await liveFile.json();
  account = String(live.account ?? "").toLowerCase() || undefined;
  expectedHash = live.configurationHash;
  if (!servicesOnly)
    check(live.configurationHash === cfg.frozenConfigurationHash, `configurationHash matches the mirror (${live.configurationHash})`, `configurationHash ${live.configurationHash} ≠ mirror ${cfg.frozenConfigurationHash}`);
  else pass(`configurationHash ${live.configurationHash}`);
  if (account) pass(`account ${account}`);
  else warn("could not read the account from live.json");
} else {
  fail(`${configurationPath} missing: freeze the go-live set (RUNBOOK § Freeze)`);
}

// 3. Snapshot service.
if (backend) {
  section(`snapshot service ${backend}`);
  const health = await getJson(`${backend}/health`);
  if (health) {
    check(health.status === 200 && health.body?.ok === true, "/health ok", `/health HTTP ${health.status}`);
    check(health.body?.frozenConfigurationHash === expectedHash, "pins the configuration hash", `pins ${health.body?.frozenConfigurationHash ?? "(not reported: old build?)"}`);
    check(health.body?.store === "postgres", "store: postgres", `store: ${health.body?.store ?? "unknown"} (set DATABASE_URL)`);
  }
  const paper = await getJson(`${backend}/paper`);
  if (paper) {
    check(paper.status === 200 && Array.isArray(paper.body?.books), `/paper serves ${paper.body?.books?.length ?? 0} books`, `/paper HTTP ${paper.status}`);
    check(paper.headers.get("access-control-allow-origin") === "*", "CORS open for the dashboard", "/paper has no CORS header");
    const last = paper.body?.lastRunAt as number | null | undefined;
    const ageMin = last ? (Date.now() / 1000 - last) / 60 : undefined;
    if (ageMin === undefined) warn("paper books have not stepped yet (they step on the first snapshot a run requests)");
    else if (ageMin > 25) warn(`paper books last stepped ${ageMin.toFixed(0)} min ago: look for "paper books not stepped" in the service log`);
    else if (ageMin < 0) pass("paper books stepped for the upcoming run (a simulation stamps the next :x0)");
    else pass(`paper books stepped ${ageMin.toFixed(0)} min ago`);
  }
}

// 4. Executor.
if (executor) {
  section(`executor ${executor}`);
  const status = await getJson(`${executor}/status`);
  const s = status?.body;
  if (status && s) {
    check(status.status === 200, "/status ok", `/status HTTP ${status.status}`);
    if (s.dryRun === true) pass("dry run (DRY_RUN unset)");
    else warn("executor is LIVE (DRY_RUN=false): orders are sent");
    check(s.verifyReports === true, "verifies DON signatures", "VERIFY_REPORTS=false: simulation only");
    check(s.frozenConfigurationHash === expectedHash, "pins the configuration hash", `pins ${s.frozenConfigurationHash}, expected ${expectedHash}`);
    if (account) check(String(s.account).toLowerCase() === account, "HL_ACCOUNT matches the frozen configuration", `HL_ACCOUNT ${s.account} ≠ ${account}`);
    check(s.store === "postgres", "store: postgres", `store: ${s.store ?? "unknown"} (set DATABASE_URL)`);
    if (s.controls?.paused === false) pass("not paused");
    else warn("kill switch is on (paused): runs are recorded but not traded");
    if (!s.pinned?.workflowName || s.pinned?.donId === null || s.pinned?.donId === undefined)
      warn("WORKFLOW_NAME / DON_ID not pinned yet: fine for dry run; set them from verify-run after the first real run");
  }
  const runs = await getJson(`${executor}/runs?summary=1&limit=5`);
  if (runs) check(runs.status === 200 && Array.isArray(runs.body), `/runs?summary=1 ok (${runs.body?.length ?? 0} runs)`, `/runs HTTP ${runs.status}`);
}

// 5. Dashboard.
if (dashboard) {
  section(`dashboard ${dashboard}`);
  const page = await getJson(dashboard);
  if (page) check(page.status === 200, "page loads", `HTTP ${page.status}`);
  warn("check in a browser that the header pills read “Dry run · Copying” (NEXT_PUBLIC_* URLs are baked in at build time)");
}

// 6. Supabase.
if (process.env.DATABASE_URL) {
  section("Supabase");
  const sql = new SQL(process.env.DATABASE_URL);
  try {
    const want = ["cre_snapshots", "executor_reports", "executor_runs", "executor_controls", "cre_eligibility", "paper_state", "paper_points", "dashboard_artifacts", "review_audit"];
    const rows = await sql`select table_name from information_schema.tables where table_schema = 'public'`;
    const have = new Set(rows.map((r: { table_name: string }) => r.table_name));
    const missing = want.filter((t) => !have.has(t));
    check(missing.length === 0, `all ${want.length} tables present`, `missing tables: ${missing.join(", ")} (run supabase/migrations)`);
    const policies = await sql`select tablename from pg_policies where 'anon' = any(roles) and cmd = 'SELECT'`;
    const readable = new Set(policies.map((p: { tablename: string }) => p.tablename));
    const closed = ["executor_runs", "cre_snapshots", "paper_points", "dashboard_artifacts"].filter((t) => !readable.has(t));
    check(closed.length === 0, "anon can read the public tables", `no anon read policy on: ${closed.join(", ")}`);
    // RLS off means Supabase's default grants let anon write; a policy "to public" includes anon.
    const open = await sql`select tablename from pg_tables where schemaname = 'public' and not rowsecurity`;
    check(open.length === 0, "row-level security on every table", `RLS off (writable by anon): ${open.map((t: { tablename: string }) => t.tablename).join(", ")}`);
    const writable = await sql`
      select tablename from pg_policies
      where schemaname = 'public' and cmd <> 'SELECT' and ('anon' = any(roles) or 'public' = any(roles))`;
    check(writable.length === 0, "anon cannot write", `write policies open to anon on: ${writable.map((p: { tablename: string }) => p.tablename).join(", ")}`);
  } catch (e) {
    fail(`Supabase: ${(e as Error).message}`);
  } finally {
    await sql.close();
  }
}

if (!backend || !executor) console.log("\n(pass --backend and --executor to check the running services)");
console.log(`\n${failed ? `${failed} failed` : "all checks passed"}${warned ? `, ${warned} warning(s)` : ""}`);
process.exit(failed ? 1 : 0);

#!/usr/bin/env bun
// Pre-deploy check (docs/ops/RUNBOOK.md § Deploy): do the frozen configuration, the backend and
// executor services, the dashboard and Supabase agree? Read-only.
//
//   bun scripts/predeploy-check.ts                                   # repo files only
//   bun scripts/predeploy-check.ts --backend https://…/api/backend --executor https://…/api/executor [--dashboard https://…]
//   DATABASE_URL=postgres://… bun scripts/predeploy-check.ts …       # also the Supabase tables
//
// --configuration <file> compares the services against that file instead of
// packages/backend/frozen/live.json (e.g. the fixture before the go-live freeze).
//
// Exit code 1 if any check fails. Warnings are things to look at, not blockers.
import { SQL } from "bun";

const args = process.argv.slice(2);
const arg = (name: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1]?.replace(/\/+$/, "") : undefined;
};
const root = new URL("..", import.meta.url).pathname;
const backend = arg("backend");
const executor = arg("executor");
const dashboard = arg("dashboard");
const configurationPath = arg("configuration") ?? "packages/backend/frozen/live.json";

let failed = 0;
let warned = 0;
const pass = (m: string) => console.log(`  ok    ${m}`);
const fail = (m: string) => (failed++, console.log(`  FAIL  ${m}`));
const warn = (m: string) => (warned++, console.log(`  warn  ${m}`));
const check = (ok: boolean, good: string, bad: string) => (ok ? pass(good) : fail(bad));
const section = (m: string) => console.log(`\n${m}`);

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

// 1. Frozen configuration the backend serves; both services must pin its hash.
section(configurationPath);
const liveFile = Bun.file(`${root}${configurationPath}`);
let account: string | undefined;
let expectedHash: string | undefined;
if (await liveFile.exists()) {
  const live = await liveFile.json();
  account = String(live.account ?? "").toLowerCase() || undefined;
  expectedHash = live.configurationHash;
  pass(`configurationHash ${live.configurationHash}`);
  if (account) pass(`account ${account}`);
  else warn("could not read the account from live.json");
} else {
  fail(`${configurationPath} missing: freeze the go-live set (RUNBOOK § Freeze)`);
}

// 2. Backend.
if (backend) {
  section(`backend ${backend}`);
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
    else if (ageMin < 0) pass("paper books stepped for the upcoming run (a local end-to-end run asks for the next :x0)");
    else pass(`paper books stepped ${ageMin.toFixed(0)} min ago`);
  }
}

// 3. Executor.
if (executor) {
  section(`executor ${executor}`);
  const status = await getJson(`${executor}/status`);
  const s = status?.body;
  if (status && s) {
    check(status.status === 200, "/status ok", `/status HTTP ${status.status}`);
    if (s.dryRun === true) pass("dry run (DRY_RUN unset)");
    else warn("executor is LIVE (DRY_RUN=false): orders are sent");
    check(s.frozenConfigurationHash === expectedHash, "pins the configuration hash", `pins ${s.frozenConfigurationHash}, expected ${expectedHash}`);
    if (account) check(String(s.account).toLowerCase() === account, "HL_ACCOUNT matches the frozen configuration", `HL_ACCOUNT ${s.account} ≠ ${account}`);
    check(s.store === "postgres", "store: postgres", `store: ${s.store ?? "unknown"} (set DATABASE_URL)`);
    if (s.controls?.paused === false) pass("not paused");
    else warn("kill switch is on (paused): runs are recorded but not traded");
  }
  const runs = await getJson(`${executor}/runs?summary=1&limit=5`);
  if (runs) {
    check(runs.status === 200 && Array.isArray(runs.body), `/runs?summary=1 ok (${runs.body?.length ?? 0} runs)`, `/runs HTTP ${runs.status}`);
    // One run every 10 minutes (Vercel Cron, or the executor's own timer when long-running).
    const last = (runs.body as { kind: string; startedAt: number; status: string }[] | undefined)?.find((r) => r.kind === "mirror");
    if (!last) warn("no scheduled run recorded yet (the first comes at the next :x0)");
    else if (Date.now() - last.startedAt > 25 * 60_000) warn(`last scheduled run started ${Math.round((Date.now() - last.startedAt) / 60_000)} min ago`);
    else pass(`last scheduled run ${Math.round((Date.now() - last.startedAt) / 60_000)} min ago: ${last.status}`);
  }
}

// 4. Dashboard.
if (dashboard) {
  section(`dashboard ${dashboard}`);
  const page = await getJson(dashboard);
  if (page) check(page.status === 200, "page loads", `HTTP ${page.status}`);
  warn("check in a browser that the header pills read “Dry run · Copying” (the dashboard reads the services on its own origin unless NEXT_PUBLIC_* URLs are set)");
}

// 5. Supabase.
if (process.env.DATABASE_URL) {
  section("Supabase");
  const sql = new SQL(process.env.DATABASE_URL);
  try {
    const want = ["run_snapshots", "executor_run_claims", "executor_runs", "executor_controls", "executor_order_batches", "run_targets", "roster_seats", "roster_events", "eligibility_state", "paper_state", "paper_points", "dashboard_artifacts", "review_audit", "paper_sessions", "paper_events"];
    const rows = await sql`select table_name from information_schema.tables where table_schema = 'public'`;
    const have = new Set(rows.map((r: { table_name: string }) => r.table_name));
    const missing = want.filter((t) => !have.has(t));
    check(missing.length === 0, `all ${want.length} tables present`, `missing tables: ${missing.join(", ")} (run supabase/migrations)`);
    // The tail of 20261007090000_rename_mirror_tables.sql: without it every run fails to save.
    const [kinds] = await sql`select pg_get_constraintdef(oid) as def from pg_constraint where conname = 'executor_runs_kind_check'`;
    check(/'mirror'/.test(kinds?.def ?? ""), "executor_runs accepts mirror runs", `executor_runs_kind_check is ${kinds?.def ?? "missing"} (run the end of 20261007090000_rename_mirror_tables.sql)`);
    const policies = await sql`select tablename from pg_policies where 'anon' = any(roles) and cmd = 'SELECT'`;
    const readable = new Set(policies.map((p: { tablename: string }) => p.tablename));
    const closed = ["executor_runs", "run_snapshots", "paper_points", "dashboard_artifacts"].filter((t) => !readable.has(t));
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

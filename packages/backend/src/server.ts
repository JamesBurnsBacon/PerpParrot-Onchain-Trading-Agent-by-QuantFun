// Backend service (README §4.7): reads the frozen sources' positions from Hyperliquid once per
// 10-minute run, turns them into the run's target exposures for the executor, steps the paper
// books, and serves the dashboard's data. Runs on Vercel as the `backend` service under
// /api/backend (vercel.json); locally: bun run dev (set CONFIGURATION_PATH and FROZEN_CONFIGURATION_HASH).
import { resolve } from "node:path";
import { SQL } from "bun";
import { waitUntil } from "@vercel/functions";
import { EligibilityTracker, MemoryEligibilityStore } from "./eligibility";
import { ActiveConfigurationSource, FileConfigurationSource } from "./configuration-source";
import { Pipeline, reviewPolicy } from "./pipeline";
import { SnapshotError, SnapshotService } from "./service";
import { exposuresFromSnapshot, MemoryPaperStore, PaperService, defaultBooks } from "./paper/service";
import { targetsFromSnapshot } from "../../shared/copy";
import type { PositionsSnapshot } from "../../shared/snapshot";
import { keccakUtf8 } from "./snapshot";
import { PostgresEligibilityStore, PostgresPaperStore, PostgresSnapshotStore, readPostgresArtifact } from "./pg-store";
import { MemorySnapshotStore } from "./snapshot";

const env = process.env;
const required = (name: string) => {
  const value = env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
};

// Supabase Postgres when DATABASE_URL is set (snapshots then survive restarts and
// are shared between instances); in memory otherwise. On Vercel any request can land on
// a fresh instance, so memory would lose snapshots and the paper books between requests.
// BACKEND_DATABASE_URL, when set, is Supabase's transaction pooler (port 6543): it shares a few
// server connections among many clients, so the backend's crons and dashboard reads don't use up
// the session pooler's 15. It can't keep prepared statements. The backend holds no session state;
// the executor's run lock does, so the executor stays on DATABASE_URL (the session pooler).
const databaseUrl = env.BACKEND_DATABASE_URL || env.DATABASE_URL;
const transactionPooler = databaseUrl ? new URL(databaseUrl).port === "6543" : false;
if (env.VERCEL && !databaseUrl) throw new Error("DATABASE_URL is required on Vercel");
if (env.VERCEL && !env.CRON_SECRET) throw new Error("CRON_SECRET is required on Vercel (Vercel Cron sends it to /cron/snapshot)");
// Supabase's session pooler allows 15 connections across every instance of both services
// (Bun's default pool is 10), and a stopped Vercel instance keeps its connections until
// they idle out. On Vercel: small pools that let go quickly (the executor takes 3).
const sql = databaseUrl
  ? new SQL(databaseUrl, { ...(env.VERCEL ? { max: 2, idleTimeout: 5 } : {}), ...(transactionPooler ? { prepare: false } : {}) })
  : undefined;
const store = sql ? new PostgresSnapshotStore(sql) : new MemorySnapshotStore();
const log = (msg: string, extra: Record<string, unknown> = {}) =>
  console.log(JSON.stringify({ t: new Date().toISOString(), msg, ...extra }));

function leadSeconds(raw: string | undefined): number {
  if (raw === undefined || raw === "") return 120;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 90 || value > 600) throw new Error("SNAPSHOT_MAX_LEAD_SECONDS must be an integer from 90 to 600");
  return value;
}

// A number from the environment, or the default when unset; anything else stops startup
// (a NaN would be saved into the paper books and never wash out).
function envNumber(name: string, fallback: number, min: number, max: number): number {
  const raw = env[name];
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < min || value > max) throw new Error(`${name} must be a number from ${min} to ${max}`);
  return value;
}

// Paper books (README §4.10), stepped once per run when its snapshot is built.
const paper = new PaperService({
  store: sql ? new PostgresPaperStore(sql) : new MemoryPaperStore(),
  specs: defaultBooks(envNumber("PAPER_BALANCED_MULTIPLIER", 0.5, 0.05, 1)),
  cfg: { minOrderUsd: 10, driftFraction: 0.1, marginCap: 0.95, slippageBps: envNumber("PAPER_SLIPPAGE_BPS", 5, 0, 100) },
});

// The pinned file (the fixture) until the pipeline activates a configuration in Supabase.
const fileConfiguration = new FileConfigurationSource(resolve(import.meta.dir, "..", required("CONFIGURATION_PATH")), required("FROZEN_CONFIGURATION_HASH"));

// The selection pipeline (src/pipeline): needs Postgres. Reviews run under the fixture's
// Aggressive policy, for our account (HL_ACCOUNT).
const pipeline = sql
  ? new Pipeline({
      sql,
      account: env.HL_ACCOUNT ?? "",
      policy: reviewPolicy(await Bun.file(resolve(import.meta.dir, "..", "fixtures/frozen-configuration.json")).json()),
      openAiKey: env.OPENAI_API_KEY,
      model: env.REVIEW_MODEL,
      gate: env.REVIEW_GATE === "strict" ? "strict" : "basic",
      log,
    })
  : undefined;

const service = new SnapshotService({
  // Relative to packages/backend, wherever the process starts (vercel.json bundles fixtures/ and frozen/).
  configurations: sql ? new ActiveConfigurationSource(sql, fileConfiguration) : fileConfiguration,
  eligibility: new EligibilityTracker(sql ? new PostgresEligibilityStore(sql) : new MemoryEligibilityStore(), undefined, (m) =>
    log("eligibility refused", { reason: m }),
  ),
  store,
  nowMs: Date.now,
  // Local end-to-end runs ask for the next :x0 ahead of time (scripts/e2e-mirror.sh): set 600 there.
  maxLeadSeconds: leadSeconds(env.SNAPSHOT_MAX_LEAD_SECONDS),
  onBuilt: (runAt, json) => {
    const step = paper.step(runAt, json).then(
      (points) => {
        if (points.length) log("paper books stepped", { runAt, books: points.length });
      },
      (e) => log("paper books not stepped", { runAt, error: (e as Error).message }),
    );
    // The snapshot is served before the books step; on Vercel this keeps the function
    // alive until they have (a no-op elsewhere).
    waitUntil(step);
    return step;
  },
});

// Dashboard artifacts (shared/dashboard.ts): Supabase, or JSON files in ARTIFACTS_DIR locally.
const readArtifact = sql
  ? readPostgresArtifact(sql)
  : async (name: string) => {
      const file = Bun.file(`${env.ARTIFACTS_DIR ?? "artifacts"}/${name}.json`);
      return (await file.exists()) ? file.json() : undefined;
    };

// Vercel Cron sends `Authorization: Bearer $CRON_SECRET` (open locally when unset).
const cronAuthorized = (req: Request) => !env.CRON_SECRET || req.headers.get("authorization") === `Bearer ${env.CRON_SECRET}`;

let exposuresCache: { runAt: number; exposures: { asset: string; fraction: number }[] } | undefined;

const server = Bun.serve({
  port: Number(env.PORT ?? 8788),
  async fetch(req) {
    const { pathname: path, searchParams } = new URL(req.url);
    // Public under /api/backend on Vercel; the bare paths serve local runs.
    const pathname = path.replace(/^\/api\/backend(?=\/|$)/, "") || "/";
    // Pinned hash and store type, for the pre-deploy check (scripts/predeploy-check.ts).
    if (req.method === "GET" && pathname === "/health") {
      return Response.json({ ok: true, frozenConfigurationHash: env.FROZEN_CONFIGURATION_HASH, store: sql ? "postgres" : "memory" });
    }
    // Vercel Cron at :x9 (vercel.json): the timer below, for a server that doesn't stay up.
    if (req.method === "GET" && pathname === "/cron/snapshot") {
      if (!cronAuthorized(req)) return Response.json({ error: "unauthorized" }, { status: 401 });
      try {
        const runAt = await service.tick();
        if (runAt) log("snapshot ready", { runAt });
        return Response.json({ runAt: runAt ?? null });
      } catch (e) {
        log("scheduled snapshot failed", { error: (e as Error).message });
        return Response.json({ error: (e as Error).message }, { status: 502 });
      }
    }
    // The selection pipeline: Vercel Cron (vercel.json), or an operator with ADMIN_TOKEN
    // (POST /admin/pipeline/scan|refresh|select; an operator's select qualifies on partial data and
    // reviews an unchanged pick).
    const step = /^\/(?:cron|admin)\/pipeline\/(scan|refresh|select)$/.exec(pathname);
    if (step && pipeline) {
      const admin = req.method === "POST" && pathname.startsWith("/admin/");
      if (admin ? !env.ADMIN_TOKEN || req.headers.get("authorization") !== `Bearer ${env.ADMIN_TOKEN}` : req.method !== "GET" || !cronAuthorized(req))
        return Response.json({ error: "unauthorized" }, { status: 401 });
      try {
        const started = Date.now();
        const result =
          step[1] === "scan" ? await pipeline.scan()
          : step[1] === "refresh" ? await pipeline.refresh(started + 240_000)
          : await pipeline.select(admin);
        return Response.json(result);
      } catch (e) {
        log(`pipeline ${step[1]} failed`, { error: (e as Error).message });
        return Response.json({ error: (e as Error).message }, { status: 502 });
      }
    }
    // Public, for the dashboard.
    const cors = { "Access-Control-Allow-Origin": "*" };
    if (req.method === "GET" && pathname === "/pipeline" && pipeline) {
      return Response.json(await pipeline.status(), { headers: cors });
    }
    if (req.method === "GET" && pathname === "/paper") {
      const since = Number(searchParams.get("since") ?? 0) || 0;
      return Response.json(await paper.view(since), { headers: cors });
    }
    // The target exposures of the last run the paper books stepped (once per run, not per request).
    if (req.method === "GET" && pathname === "/exposures") {
      const { lastRunAt } = await paper.view(Number.MAX_SAFE_INTEGER);
      if (!lastRunAt) return Response.json({ error: "no run yet" }, { status: 404, headers: cors });
      if (exposuresCache?.runAt !== lastRunAt) {
        const exposures = exposuresFromSnapshot(JSON.parse(await service.get(lastRunAt)));
        exposuresCache = { runAt: lastRunAt, exposures: [...exposures].map(([asset, fraction]) => ({ asset, fraction })) };
      }
      return Response.json(exposuresCache, { headers: cors });
    }
    const artifact = /^\/artifacts\/(backtest|funnel)$/.exec(pathname);
    if (req.method === "GET" && artifact) {
      const body = await readArtifact(artifact[1]);
      return body === undefined
        ? Response.json({ error: "not published yet" }, { status: 404, headers: cors })
        : Response.json(body, { headers: cors });
    }

    // GET /snapshots/:runAt: the positions read for a run (public, for audit).
    // GET /targets/:runAt: that run's target exposures, which the executor trades toward.
    const m = /^\/(snapshots|targets)\/(\d{1,12})$/.exec(pathname);
    if (req.method !== "GET" || !m) return new Response("not found", { status: 404 });

    const runAt = Number(m[2]);
    try {
      const json = await service.get(runAt);
      if (m[1] === "snapshots") {
        log("snapshot served", { runAt, bytes: json.length });
        return new Response(json, { headers: { "Content-Type": "application/json", ...cors } });
      }
      const snapshot = JSON.parse(json) as PositionsSnapshot;
      const targets = {
        runId: `mirror-${runAt}`,
        runAt,
        snapshotHash: keccakUtf8(json),
        configurationHash: snapshot.configuration.configurationHash,
        account: snapshot.configuration.account,
        exposures: targetsFromSnapshot(snapshot).map((e) => ({ asset: e.asset, exposureE9: e.exposureE9.toString() })),
      };
      log("targets served", { runAt, exposures: targets.exposures.length });
      return Response.json(targets, { headers: cors });
    } catch (e) {
      const status = e instanceof SnapshotError ? e.status : 502;
      log("snapshot failed", { runAt, status, error: (e as Error).message });
      return Response.json({ error: (e as Error).message }, { status });
    }
  },
});

// Check every 15 s; tick() only builds inside the window before each :x0 run. Not on
// Vercel, where instances stop between requests: /cron/snapshot runs it there.
if (!env.VERCEL) {
  setInterval(() => {
    service
      .tick()
      .then((runAt) => runAt && log("snapshot ready", { runAt }))
      .catch((e) => log("scheduled snapshot failed", { error: (e as Error).message }));
  }, 15_000);
}

log("snapshot service listening", { port: server.port, store: databaseUrl ? (transactionPooler ? "postgres (transaction pooler)" : "postgres") : "memory" });

// Positions snapshot API for the mirror workflow (README §4.7). Runs on Vercel as the
// `backend` service under /api/backend (vercel.json); locally: bun run dev (set
// CONFIGURATION_PATH and FROZEN_CONFIGURATION_HASH).
import { resolve } from "node:path";
import { SQL } from "bun";
import { waitUntil } from "@vercel/functions";
import { EligibilityTracker, MemoryEligibilityStore } from "./eligibility";
import { FileConfigurationSource } from "./configuration-source";
import { SnapshotError, SnapshotService } from "./service";
import { exposuresFromSnapshot, MemoryPaperStore, PaperService, defaultBooks } from "./paper/service";
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
if (env.VERCEL && !env.DATABASE_URL) throw new Error("DATABASE_URL is required on Vercel");
if (env.VERCEL && !env.CRON_SECRET) throw new Error("CRON_SECRET is required on Vercel (Vercel Cron sends it to /cron/snapshot)");
const sql = env.DATABASE_URL ? new SQL(env.DATABASE_URL) : undefined;
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

const service = new SnapshotService({
  // Relative to packages/backend, wherever the process starts (vercel.json bundles fixtures/ and frozen/).
  configurations: new FileConfigurationSource(resolve(import.meta.dir, "..", required("CONFIGURATION_PATH")), required("FROZEN_CONFIGURATION_HASH")),
  eligibility: new EligibilityTracker(sql ? new PostgresEligibilityStore(sql) : new MemoryEligibilityStore(), undefined, (m) =>
    log("eligibility refused", { reason: m }),
  ),
  store,
  nowMs: Date.now,
  // Only `cre workflow simulate` needs more (it stamps the next :x0): set 600 locally.
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
    // Public, for the dashboard.
    const cors = { "Access-Control-Allow-Origin": "*" };
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

    const m = /^\/snapshots\/(\d{1,12})$/.exec(pathname);
    if (req.method !== "GET" || !m) return new Response("not found", { status: 404 });

    const runAt = Number(m[1]);
    try {
      const json = await service.get(runAt);
      log("snapshot served", { runAt, bytes: json.length });
      return new Response(json, { headers: { "Content-Type": "application/json" } });
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

log("snapshot service listening", { port: server.port, store: env.DATABASE_URL ? "postgres" : "memory" });

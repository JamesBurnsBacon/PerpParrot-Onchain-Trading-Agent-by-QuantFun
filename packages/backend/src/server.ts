// Positions snapshot API for the mirror workflow (README §4.7). Runs on Railway;
// locally: bun run dev (set CONFIGURATION_PATH and FROZEN_CONFIGURATION_HASH).
import { SQL } from "bun";
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
// are shared between instances); in memory otherwise.
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

// Paper books (README §4.10), stepped once per run when its snapshot is built.
const paper = new PaperService({
  store: sql ? new PostgresPaperStore(sql) : new MemoryPaperStore(),
  specs: defaultBooks(Number(env.PAPER_BALANCED_MULTIPLIER ?? 0.5)),
  cfg: { minOrderUsd: 10, driftFraction: 0.1, marginCap: 0.95, slippageBps: Number(env.PAPER_SLIPPAGE_BPS ?? 5) },
});

const service = new SnapshotService({
  configurations: new FileConfigurationSource(required("CONFIGURATION_PATH"), required("FROZEN_CONFIGURATION_HASH")),
  eligibility: new EligibilityTracker(sql ? new PostgresEligibilityStore(sql) : new MemoryEligibilityStore(), undefined, (m) =>
    log("eligibility refused", { reason: m }),
  ),
  store,
  nowMs: Date.now,
  // Only `cre workflow simulate` needs more (it stamps the next :x0): set 600 locally.
  maxLeadSeconds: leadSeconds(env.SNAPSHOT_MAX_LEAD_SECONDS),
  onBuilt: async (runAt, json) => {
    const points = await paper.step(runAt, json);
    if (points.length) log("paper books stepped", { runAt, books: points.length });
  },
});

// Dashboard artifacts (shared/dashboard.ts): Supabase, or JSON files in ARTIFACTS_DIR locally.
const readArtifact = sql
  ? readPostgresArtifact(sql)
  : async (name: string) => {
      const file = Bun.file(`${env.ARTIFACTS_DIR ?? "artifacts"}/${name}.json`);
      return (await file.exists()) ? file.json() : undefined;
    };

const server = Bun.serve({
  port: Number(env.PORT ?? 8788),
  async fetch(req) {
    const { pathname, searchParams } = new URL(req.url);
    if (req.method === "GET" && pathname === "/health") return Response.json({ ok: true });
    // Public, for the dashboard.
    const cors = { "Access-Control-Allow-Origin": "*" };
    if (req.method === "GET" && pathname === "/paper") {
      const since = Number(searchParams.get("since") ?? 0) || 0;
      return Response.json(await paper.view(since), { headers: cors });
    }
    if (req.method === "GET" && pathname === "/exposures") {
      const { lastRunAt } = await paper.view(Number.MAX_SAFE_INTEGER);
      if (!lastRunAt) return Response.json({ error: "no run yet" }, { status: 404, headers: cors });
      const exposures = exposuresFromSnapshot(JSON.parse(await service.get(lastRunAt)));
      return Response.json({ runAt: lastRunAt, exposures: [...exposures].map(([asset, fraction]) => ({ asset, fraction })) }, { headers: cors });
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

// Check every 15 s; tick() only builds inside the window before each :x0 run.
setInterval(() => {
  service
    .tick()
    .then((runAt) => runAt && log("snapshot ready", { runAt }))
    .catch((e) => log("scheduled snapshot failed", { error: (e as Error).message }));
}, 15_000);

log("snapshot service listening", { port: server.port, store: env.DATABASE_URL ? "postgres" : "memory" });

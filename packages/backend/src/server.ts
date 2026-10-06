// Positions snapshot API for the mirror workflow (README §4.7). Runs on Railway;
// locally: bun run dev (set CONFIGURATION_PATH and FROZEN_CONFIGURATION_HASH).
import { SQL } from "bun";
import { EligibilityTracker } from "./eligibility";
import { FileConfigurationSource } from "./configuration-source";
import { SnapshotError, SnapshotService } from "./service";
import { PostgresSnapshotStore } from "./pg-store";
import { MemorySnapshotStore } from "./snapshot";

const env = process.env;
const required = (name: string) => {
  const value = env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
};

// Supabase Postgres when DATABASE_URL is set (snapshots then survive restarts and
// are shared between instances); in memory otherwise.
const store = env.DATABASE_URL ? new PostgresSnapshotStore(new SQL(env.DATABASE_URL)) : new MemorySnapshotStore();

const service = new SnapshotService({
  configurations: new FileConfigurationSource(required("CONFIGURATION_PATH"), required("FROZEN_CONFIGURATION_HASH")),
  eligibility: new EligibilityTracker(),
  store,
  nowMs: Date.now,
});

const log = (msg: string, extra: Record<string, unknown> = {}) =>
  console.log(JSON.stringify({ t: new Date().toISOString(), msg, ...extra }));

const server = Bun.serve({
  port: Number(env.PORT ?? 8788),
  async fetch(req) {
    const { pathname } = new URL(req.url);
    if (req.method === "GET" && pathname === "/health") return Response.json({ ok: true });

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
  service.tick().then(
    (runAt) => runAt && log("snapshot ready", { runAt }),
    (e) => log("scheduled snapshot failed", { error: (e as Error).message }),
  );
}, 15_000);

log("snapshot service listening", { port: server.port, store: env.DATABASE_URL ? "postgres" : "memory" });

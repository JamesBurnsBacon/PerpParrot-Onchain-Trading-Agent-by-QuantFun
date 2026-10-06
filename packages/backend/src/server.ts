import { MAX_INPUT_TOKENS, MAX_COMPLETION_TOKENS } from "./chat/budget";
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
import { handleChat, handlePreview, MemoryRequestStore, PostgresRequestStore, type ChatDeps, type ChatEnv } from "./chat/handler";
import { MemoryChatLimiter, PostgresChatLimiter } from "./chat/limits";
import { callIntentModel } from "./chat/openai";
import { loadFinalists } from "./chat/finalists";
import { readLiveEnv } from "./live/config";
import { handleLiveSession, handleLiveStrategy } from "./live/handler";
import { validateRuntimePolicy } from "../../shared/src/policy-runtime";

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
// Supabase's session pooler allows 15 connections across every instance of both services
// (Bun's default pool is 10), and a stopped Vercel instance keeps its connections until
// they idle out. On Vercel: small pools that let go quickly (the executor takes 3).
const sql = env.DATABASE_URL ? new SQL(env.DATABASE_URL, env.VERCEL ? { max: 2, idleTimeout: 5 } : {}) : undefined;
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

const configurations = new FileConfigurationSource(resolve(import.meta.dir, "..", required("CONFIGURATION_PATH")), required("FROZEN_CONFIGURATION_HASH"));

const service = new SnapshotService({
  // Relative to packages/backend, wherever the process starts (vercel.json bundles fixtures/ and frozen/).
  configurations,
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

// Chat variables are optional; invalid values fall back without changing the
// strict parsing of the existing service's environment variables.
const chatNumber = (name: string, fallback: number, max = Number.MAX_SAFE_INTEGER, integer = false): number => {
  try {
    const value = envNumber(name, fallback, 0, max);
    return integer && !Number.isSafeInteger(value) ? fallback : value;
  } catch {
    return fallback;
  }
};
const chatEnv: ChatEnv = {
  enabled: env.CHAT_ENABLED === "true",
  apiKey: env.OPENAI_API_KEY || undefined,
  model: env.CHAT_MODEL || "gpt-5.4-mini",
  limits: {
    ipHourly: chatNumber("CHAT_IP_HOURLY_LIMIT", 10, Number.MAX_SAFE_INTEGER, true),
    previewIpHourly: chatNumber("CHAT_PREVIEW_IP_HOURLY_LIMIT", 30, Number.MAX_SAFE_INTEGER, true),
    globalDaily: chatNumber("CHAT_GLOBAL_DAILY_LIMIT", 100, Number.MAX_SAFE_INTEGER, true),
    previewGlobalDaily: chatNumber("CHAT_PREVIEW_GLOBAL_DAILY_LIMIT", 500, Number.MAX_SAFE_INTEGER, true),
    dailyBudgetMicroUsd: Math.round(chatNumber("CHAT_DAILY_BUDGET_USD", 5, 100) * 1_000_000),
  },
  // Conservative ESTIMATES, USD per million tokens. Keep worst-case arithmetic
  // within safe integer micro-USD even with misconfigured optional prices.
  priceInPerM: chatNumber("CHAT_PRICE_IN_PER_M_USD", 1, Number.MAX_SAFE_INTEGER / (MAX_INPUT_TOKENS + MAX_COMPLETION_TOKENS)),
  priceOutPerM: chatNumber("CHAT_PRICE_OUT_PER_M_USD", 4, Number.MAX_SAFE_INTEGER / (MAX_INPUT_TOKENS + MAX_COMPLETION_TOKENS)),
  ipSalt: env.CHAT_IP_SALT ?? "perpparrot-chat-v1",
};
const chatStores = {
  limiter: sql ? new PostgresChatLimiter(sql) : new MemoryChatLimiter(),
  requests: sql ? new PostgresRequestStore(sql) : new MemoryRequestStore(),
};
const liveEnv = readLiveEnv(env);
let chatDeps: Promise<ChatDeps> | undefined;
const loadChatDeps = (): Promise<ChatDeps> => chatDeps ??= configurations.load(Date.now()).then(
  ({ policy }): ChatDeps => {
    // The snapshot source types only the mirror's subset; chat needs the full policy.
    validateRuntimePolicy(policy);
    return { env: chatEnv, ...chatStores, callModel: callIntentModel, finalists: loadFinalists,
      basePolicy: policy, now: Date.now, log, newId: () => crypto.randomUUID() };
  },
).catch((error: unknown) => {
  // A temporary file failure disables this request; a later request may retry.
  chatDeps = undefined;
  throw error;
});
const chatCors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "content-type",
};
const chatDisabled = () => Response.json(
  { ok: false, code: "disabled", reply: "Squawk, chat is resting right now." },
  { status: 503, headers: chatCors },
);

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
    if (pathname === "/live/session" || pathname === "/live/strategy") {
      if (!liveEnv.enabled || (pathname === "/live/session" && !liveEnv.apiKey)) return chatDisabled();
      if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: chatCors });
      let chat: ChatDeps;
      try { chat = await loadChatDeps(); }
      catch { return chatDisabled(); }
      const deps = { ...chat, env: liveEnv, chatEnv, fetchImpl: fetch };
      const response = await (pathname === "/live/session" ? handleLiveSession(req, deps) : handleLiveStrategy(req, deps));
      for (const [name, value] of Object.entries(chatCors)) response.headers.set(name, value);
      return response;
    }
    if (pathname === "/chat" || pathname === "/chat/preview") {
      if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: chatCors });
      if (req.method === "POST") {
        if (!chatEnv.enabled || (pathname === "/chat" && !chatEnv.apiKey)) return chatDisabled();
        let deps: ChatDeps;
        try { deps = await loadChatDeps(); }
        catch { return chatDisabled(); }
        const response = await (pathname === "/chat" ? handleChat(req, deps) : handlePreview(req, deps));
        for (const [name, value] of Object.entries(chatCors)) response.headers.set(name, value);
        return response;
      }
    }
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

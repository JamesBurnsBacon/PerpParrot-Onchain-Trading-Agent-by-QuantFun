// Executor service (README §4.8): once per 10-minute run, takes the backend's target exposures,
// sizes them with our live equity and trades. Dry run on Vercel (the `executor` service under
// /api/executor, triggered by Vercel Cron); live trading needs one long-running process, where a
// timer triggers the runs. Locally: bun run dev.
import { SQL } from "bun";
import { createAlert } from "./alerts";
import { createApp, triggerRun } from "./app";
import { loadConfig } from "./config";
import { createExchange } from "./exchange";
import { httpInfo } from "./hyperliquid";
import { Runner } from "./runner";
import { noLock, postgresRunLock } from "./lock";
import { PostgresStore } from "./pg-store";
import { MemoryStore } from "./store";
import { backendTargets, dueRunAt } from "./targets";
import { cronWatchdog } from "./watchdog";

const config = loadConfig(process.env);
const log = (msg: string, extra: Record<string, unknown> = {}) =>
  console.log(JSON.stringify({ t: new Date().toISOString(), msg, ...extra }));

// Supabase Postgres supplies durable run claims, runs, controls and action journals.
// Production configuration rejects a missing DATABASE_URL.
// Small pools: Supabase's session pooler allows 15 connections across every instance of the
// executor (the backend uses the transaction pooler). 3, not fewer: a run holds one for the run
// lock (lock.ts) while its queries need another, and an operator action may wait on the lock with
// a third. On Vercel they let go quickly; the long-running executor (Railway) keeps 4.
const sql = process.env.DATABASE_URL ? new SQL(process.env.DATABASE_URL, config.vercel ? { max: 3, idleTimeout: 5 } : { max: 4 }) : undefined;
const store = sql ? new PostgresStore(sql) : new MemoryStore();
const alert = createAlert({ botToken: config.telegramBotToken, chatId: config.telegramChatId, log: (m) => log(m) });
// Report write-ahead intents a crash left without a recorded outcome. Nothing is paused: the next
// run reconciles them from Hyperliquid automatically (reconcile.ts). Never fatal, so a database
// blip at a (serverless) cold start can't take /health, /status or /admin/pause down with it.
try {
  const unresolvedOnStartup = await store.unresolvedOrderBatches();
  if (unresolvedOnStartup.length > 0) {
    log("unresolved order actions at startup; the next run reconciles them", { batches: unresolvedOnStartup.map((b) => b.id) });
  }
} catch (e) {
  log("startup recovery check failed; runs re-check before trading", { error: (e as Error).message });
}

const exchange = createExchange({ privateKey: config.apiWalletKey, dryRun: config.dryRun });
const runner = new Runner({
  store,
  exchange,
  info: httpInfo(),
  alert,
  now: Date.now,
  lock: sql ? postgresRunLock(sql) : noLock,
  targets: backendTargets(config.backendUrl),
  // The table is absent until the pipeline migration runs: then the pinned hash applies.
  activeConfigurationHash: sql
    ? async () => {
        try {
          const [row] = await sql`select hash from configurations where status = 'active'`;
          return row?.hash as string | undefined;
        } catch {
          return undefined;
        }
      }
    : undefined,
  config: {
    account: config.account,
    frozenConfigurationHash: config.frozenConfigurationHash,
    maxGrossLeverage: config.maxGrossLeverage,
    runTtlSeconds: config.runTtlSeconds,
    runTimeoutMs: config.runTimeoutMs,
    dryRunEquityUsd: config.dryRunEquityUsd,
    plan: {
      minOrderUsd: config.minOrderUsd,
      driftFraction: config.driftFraction,
      equityBandFraction: config.equityBandFraction,
      marginCap: config.marginCap,
      slippageBps: config.slippageBps,
    },
  },
});

const app = createApp({
  runner,
  store,
  adminToken: config.adminToken,
  cronSecret: config.cronSecret,
  watchdog: cronWatchdog({ store, alert, now: Date.now, afterMs: config.missedRunAlertMinutes * 60_000, everyMs: 5 * 60_000 }),
  log,
  status: () => ({
    dryRun: config.dryRun,
    account: config.account,
    apiWallet: exchange.signer,
    frozenConfigurationHash: config.frozenConfigurationHash,
    lastRunAt: runner.lastRunAt || null,
    store: sql ? "postgres" : "memory",
  }),
});

// Request bodies are tiny (admin actions); cap them anyway.
const server = Bun.serve({ port: config.port, fetch: app, maxRequestBodySize: 256 * 1024 });

// A long-running host triggers its own runs at each :x0 (on Vercel, Vercel Cron calls /cron/run).
// The per-run claim makes this safe alongside any other trigger.
let lastTriggered = 0;
if (!config.vercel) setInterval(() => {
  const runAt = dueRunAt(Date.now());
  if (runAt === null || runAt === lastTriggered) return;
  lastTriggered = runAt;
  triggerRun({ runner, store, log }, runAt).catch((e) => log("run trigger failed", { runAt, error: (e as Error).message }));
}, 15_000);

// Missed-run watchdog: runs come every 10 min, so no finished run means runs are failing or
// one is stuck (README §4.7: alert after 2 consecutive failures). /cron/watchdog on Vercel.
const startedAt = Date.now();
let alerted = false;
if (!config.vercel) setInterval(() => {
  const since = Date.now() - (runner.lastFinishedAt || startedAt);
  if (since > config.missedRunAlertMinutes * 60_000) {
    if (!alerted) void alert(`no finished run for ${Math.round(since / 60_000)} min (last run started ${runner.lastRunAt ? new Date(runner.lastRunAt).toISOString() : "never"})`);
    alerted = true;
  } else {
    alerted = false;
  }
}, 60_000);

log("executor listening", {
  port: server.port,
  dryRun: config.dryRun,
  backend: config.backendUrl,
  account: config.account,
  store: process.env.DATABASE_URL ? "postgres" : "memory",
});

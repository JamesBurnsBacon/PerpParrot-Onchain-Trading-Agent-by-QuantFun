// Executor service (README §4.8). Runs on Vercel as the `executor` service under
// /api/executor (vercel.json), dry run only there; locally: bun run dev.
import { SQL } from "bun";
import { waitUntil } from "@vercel/functions";
import { createPublicClient, http } from "viem";
import { mainnet } from "viem/chains";
import { createAlert } from "./alerts";
import { createApp } from "./app";
import { loadConfig } from "./config";
import { createExchange } from "./exchange";
import { httpInfo } from "./hyperliquid";
import { Runner } from "./runner";
import { registrySigners } from "./signers";
import { PostgresStore } from "./pg-store";
import { MemoryStore } from "./store";
import type { VerifyMode } from "./verify";
import { cronWatchdog } from "./watchdog";

const config = loadConfig(process.env);
const log = (msg: string, extra: Record<string, unknown> = {}) =>
  console.log(JSON.stringify({ t: new Date().toISOString(), msg, ...extra }));

const mode: VerifyMode = config.verifyReports
  ? {
      kind: "registry",
      signers: registrySigners(createPublicClient({ chain: mainnet, transport: http(config.ethRpcUrl) })),
      workflowOwner: config.workflowOwner,
      workflowName: config.workflowName,
      donId: config.donId,
    }
  : { kind: "simulation" };

// Supabase Postgres when DATABASE_URL is set: report dedupe, runs and the kill
// switch then survive restarts. In memory otherwise (report expiry still bounds replays).
const store = process.env.DATABASE_URL ? new PostgresStore(new SQL(process.env.DATABASE_URL)) : new MemoryStore();
if (config.production && !process.env.DATABASE_URL) {
  console.warn("DATABASE_URL not set: report dedupe, runs and the kill switch won't survive a restart");
}
const exchange = createExchange({ privateKey: config.apiWalletKey, dryRun: config.dryRun });
const alert = createAlert({ botToken: config.telegramBotToken, chatId: config.telegramChatId, log: (m) => log(m) });
const runner = new Runner({
  store,
  exchange,
  info: httpInfo(),
  alert,
  now: Date.now,
  config: {
    account: config.account,
    maxGrossLeverage: config.maxGrossLeverage,
    runTimeoutMs: config.runTimeoutMs,
    plan: {
      minOrderUsd: config.minOrderUsd,
      driftFraction: config.driftFraction,
      marginCap: config.marginCap,
      slippageBps: config.slippageBps,
    },
  },
});

const app = createApp({
  handler: {
    mode,
    frozenConfigurationHash: config.frozenConfigurationHash,
    account: config.account,
    now: () => Math.floor(Date.now() / 1000),
    maxLeadSeconds: config.maxReportLeadSeconds,
    maxTtlSeconds: config.maxReportTtlSeconds,
  },
  runner,
  store,
  adminToken: config.adminToken,
  watchdog: cronWatchdog({ store, alert, now: Date.now, afterMs: config.missedRunAlertMinutes * 60_000, everyMs: 5 * 60_000 }),
  cronSecret: config.cronSecret,
  background: waitUntil,
  log,
  status: () => ({
    dryRun: config.dryRun,
    verifyReports: config.verifyReports,
    account: config.account,
    apiWallet: exchange.signer,
    frozenConfigurationHash: config.frozenConfigurationHash,
    lastReportAt: runner.lastReportAt || null,
    // For the pre-deploy check (scripts/predeploy-check.ts).
    store: process.env.DATABASE_URL ? "postgres" : "memory",
    pinned: { workflowName: config.workflowName ?? null, donId: config.donId ?? null },
  }),
});

// Reports are a few KB; cap bodies well above that.
const server = Bun.serve({ port: config.port, fetch: app, maxRequestBodySize: 256 * 1024 });

// Missed-run watchdog: mirror runs every 10 min, so no finished run means CRE runs are
// failing or a run is stuck (README §4.7: alert after 2 consecutive failures). Not on
// Vercel, where instances stop between requests: Vercel Cron calls /cron/watchdog there.
const startedAt = Date.now();
let alerted = false;
if (!config.vercel) {
  setInterval(() => {
    const since = Date.now() - (runner.lastFinishedAt || startedAt);
    if (since > config.missedRunAlertMinutes * 60_000) {
      if (!alerted) void alert(`no finished run for ${Math.round(since / 60_000)} min (last report accepted ${runner.lastReportAt ? new Date(runner.lastReportAt).toISOString() : "never"})`);
      alerted = true;
    } else {
      alerted = false;
    }
  }, 60_000);
}

log("executor listening", {
  port: server.port,
  dryRun: config.dryRun,
  verify: config.verifyReports ? "registry" : "simulation",
  account: config.account,
  store: process.env.DATABASE_URL ? "postgres" : "memory",
});

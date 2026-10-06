// Executor service (README §4.8). Runs on Railway; locally: bun run dev.
import { SQL } from "bun";
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

const config = loadConfig(process.env);
const log = (msg: string, extra: Record<string, unknown> = {}) =>
  console.log(JSON.stringify({ t: new Date().toISOString(), msg, ...extra }));

const mode: VerifyMode = config.verifyReports
  ? {
      kind: "registry",
      signers: registrySigners(createPublicClient({ chain: mainnet, transport: http(config.ethRpcUrl) })),
      workflowOwner: config.workflowOwner,
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
    equityTolerance: config.equityTolerance,
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
  },
  runner,
  store,
  adminToken: config.adminToken,
  log,
  status: () => ({
    dryRun: config.dryRun,
    verifyReports: config.verifyReports,
    account: config.account,
    apiWallet: exchange.signer,
    frozenConfigurationHash: config.frozenConfigurationHash,
    lastReportAt: runner.lastReportAt || null,
  }),
});

const server = Bun.serve({ port: config.port, fetch: app });

// Missed-run watchdog: mirror runs every 10 min, so silence means CRE runs are failing
// (README §4.7: alert after 2 consecutive failures).
const startedAt = Date.now();
let alerted = false;
setInterval(() => {
  const since = Date.now() - (runner.lastReportAt || startedAt);
  if (since > config.missedRunAlertMinutes * 60_000) {
    if (!alerted) void alert(`no report for ${Math.round(since / 60_000)} min`);
    alerted = true;
  } else {
    alerted = false;
  }
}, 60_000);

log("executor listening", {
  port: server.port,
  dryRun: config.dryRun,
  verify: config.verifyReports ? "registry" : "simulation",
  account: config.account,
  store: process.env.DATABASE_URL ? "postgres" : "memory",
});

import type { Hex } from "viem";

export type ExecutorConfig = {
  port: number;
  production: boolean;
  // Deployed on Vercel (vercel.json): no in-process timers, and Vercel Cron calls /cron/watchdog.
  vercel: boolean;
  cronSecret?: string;
  verifyReports: boolean;
  workflowOwner: Hex;
  ethRpcUrl: string;
  frozenConfigurationHash: string;
  account: Hex;
  apiWalletKey?: Hex;
  dryRun: boolean;
  slippageBps: number;
  minOrderUsd: number;
  driftFraction: number;
  marginCap: number;
  maxGrossLeverage: number;
  adminToken?: string;
  telegramBotToken?: string;
  telegramChatId?: string;
  missedRunAlertMinutes: number;
  maxReportLeadSeconds: number;
  maxReportTtlSeconds: number;
  runTimeoutMs: number;
  workflowName?: Hex;
  donId?: number;
};

const hex = (name: string, value: string | undefined, bytes: number): Hex => {
  if (!value || !new RegExp(`^0x[0-9a-fA-F]{${bytes * 2}}$`).test(value)) {
    throw new Error(`${name} must be a 0x-prefixed ${bytes}-byte hex value`);
  }
  return value.toLowerCase() as Hex;
};

const num = (env: Record<string, string | undefined>, name: string, fallback: number): number => {
  const raw = env[name];
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value)) throw new Error(`${name} must be a number`);
  return value;
};

// Safe by default: DRY_RUN and VERIFY_REPORTS are on unless explicitly "false",
// and production (any Vercel deployment, previews too) refuses to run without report verification.
export const loadConfig = (env: Record<string, string | undefined>): ExecutorConfig => requirePinsForLive(readConfig(env));

const readConfig = (env: Record<string, string | undefined>): ExecutorConfig => {
  const vercel = !!env.VERCEL;
  const production = env.NODE_ENV === "production" || vercel;
  const verifyReports = env.VERIFY_REPORTS !== "false";
  if (production && !verifyReports) throw new Error("VERIFY_REPORTS=false is not allowed in production");
  const dryRun = env.DRY_RUN !== "false";
  if (!dryRun && !verifyReports) throw new Error("VERIFY_REPORTS=false is only allowed with DRY_RUN");
  const apiWalletKey = env.HL_API_WALLET_KEY ? hex("HL_API_WALLET_KEY", env.HL_API_WALLET_KEY, 32) : undefined;
  if (!dryRun && !apiWalletKey) throw new Error("HL_API_WALLET_KEY is required when DRY_RUN=false");
  if (production && !env.ADMIN_TOKEN) throw new Error("ADMIN_TOKEN is required in production");
  // Live trading needs one long-running process: one HL nonce sequence and an in-process run
  // queue (README §4.8). Vercel may run several instances and stops them between requests.
  if (vercel && !dryRun) throw new Error("DRY_RUN=false is not allowed on Vercel: live trading needs one long-running executor (README §4.8)");
  // Instances don't outlive requests there, so memory would lose dedupe, runs and the kill switch.
  if (vercel && !env.DATABASE_URL) throw new Error("DATABASE_URL is required on Vercel");
  if (vercel && !env.CRON_SECRET) throw new Error("CRON_SECRET is required on Vercel (Vercel Cron sends it to /cron/watchdog)");

  return {
    port: num(env, "PORT", 8787),
    production,
    vercel,
    cronSecret: env.CRON_SECRET || undefined,
    verifyReports,
    workflowOwner: hex("WORKFLOW_OWNER", env.WORKFLOW_OWNER, 20),
    ethRpcUrl: env.ETH_MAINNET_RPC_URL || "https://ethereum-rpc.publicnode.com",
    frozenConfigurationHash: hex("FROZEN_CONFIGURATION_HASH", env.FROZEN_CONFIGURATION_HASH, 32),
    account: hex("HL_ACCOUNT", env.HL_ACCOUNT, 20),
    apiWalletKey,
    dryRun,
    slippageBps: num(env, "SLIPPAGE_BPS", 50),
    minOrderUsd: num(env, "MIN_ORDER_USD", 10),
    driftFraction: num(env, "DRIFT_FRACTION", 0.1),
    marginCap: num(env, "MARGIN_CAP", 0.95),
    maxGrossLeverage: num(env, "MAX_GROSS_LEVERAGE", 10),
    adminToken: env.ADMIN_TOKEN || undefined,
    telegramBotToken: env.TELEGRAM_BOT_TOKEN || undefined,
    telegramChatId: env.TELEGRAM_CHAT_ID || undefined,
    missedRunAlertMinutes: num(env, "MISSED_RUN_ALERT_MINUTES", 25),
    maxReportLeadSeconds: num(env, "MAX_REPORT_LEAD_SECONDS", 60),
    maxReportTtlSeconds: num(env, "MAX_REPORT_TTL_SECONDS", 300),
    runTimeoutMs: num(env, "RUN_TIMEOUT_SECONDS", 60) * 1000,
    workflowName: env.WORKFLOW_NAME ? hex("WORKFLOW_NAME", env.WORKFLOW_NAME, 10) : undefined,
    donId: env.DON_ID ? num(env, "DON_ID", 0) : undefined,
  };
};

// Live trading in production must pin the exact workflow and DON (copied from the first
// dry-run report: verify-run prints both), not just our organization.
export const requirePinsForLive = (c: ExecutorConfig): ExecutorConfig => {
  if (c.production && !c.dryRun && (!c.workflowName || c.donId === undefined)) {
    throw new Error("WORKFLOW_NAME and DON_ID are required to trade live in production");
  }
  return c;
};

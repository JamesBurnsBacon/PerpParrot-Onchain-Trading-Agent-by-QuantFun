import type { Hex } from "viem";

export type ExecutorConfig = {
  port: number;
  production: boolean;
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
// and production refuses to run without report verification.
export const loadConfig = (env: Record<string, string | undefined>): ExecutorConfig => requirePinsForLive(readConfig(env));

const readConfig = (env: Record<string, string | undefined>): ExecutorConfig => {
  const production = env.NODE_ENV === "production";
  const verifyReports = env.VERIFY_REPORTS !== "false";
  if (production && !verifyReports) throw new Error("VERIFY_REPORTS=false is not allowed in production");
  const dryRun = env.DRY_RUN !== "false";
  if (!dryRun && !verifyReports) throw new Error("VERIFY_REPORTS=false is only allowed with DRY_RUN");
  const apiWalletKey = env.HL_API_WALLET_KEY ? hex("HL_API_WALLET_KEY", env.HL_API_WALLET_KEY, 32) : undefined;
  if (!dryRun && !apiWalletKey) throw new Error("HL_API_WALLET_KEY is required when DRY_RUN=false");
  if (production && !env.ADMIN_TOKEN) throw new Error("ADMIN_TOKEN is required in production");
  if (production && !env.DATABASE_URL) throw new Error("DATABASE_URL is required in production for durable report dedupe and kill switch");

  return {
    port: num(env, "PORT", 8787),
    production,
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

import type { Hex } from "viem";

export type ExecutorConfig = {
  port: number;
  production: boolean;
  vercel: boolean;
  // The backend's base URL: its targets for each run (targets.ts).
  backendUrl: string;
  frozenConfigurationHash: string;
  account: Hex;
  apiWalletKey?: Hex;
  dryRun: boolean;
  slippageBps: number;
  minOrderUsd: number;
  driftFraction: number;
  equityBandFraction: number;
  marginCap: number;
  maxGrossLeverage: number;
  adminToken?: string;
  cronSecret?: string;
  telegramBotToken?: string;
  telegramChatId?: string;
  missedRunAlertMinutes: number;
  runTtlSeconds: number;
  runTimeoutMs: number;
  dryRunEquityUsd?: number;
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

// Safe by default: DRY_RUN is on unless explicitly "false", and production (any Vercel
// deployment, previews too) requires an admin token and durable storage.
export const loadConfig = (env: Record<string, string | undefined>): ExecutorConfig => {
  const vercel = env.VERCEL === "1";
  const production = env.NODE_ENV === "production" || vercel;
  const dryRun = env.DRY_RUN !== "false";
  const apiWalletKey = env.HL_API_WALLET_KEY ? hex("HL_API_WALLET_KEY", env.HL_API_WALLET_KEY, 32) : undefined;
  if (!dryRun && !apiWalletKey) throw new Error("HL_API_WALLET_KEY is required when DRY_RUN=false");
  if (production && !env.ADMIN_TOKEN) throw new Error("ADMIN_TOKEN is required in production");
  if (vercel && !env.DATABASE_URL) throw new Error("DATABASE_URL is required on Vercel");
  if (production && !env.DATABASE_URL) throw new Error("DATABASE_URL is required in production for durable run claims and kill switch");
  // Serverless instances cannot safely hold live execution state or a single order nonce sequence.
  if (vercel && !dryRun) throw new Error("DRY_RUN=false is not allowed on Vercel: live trading needs one long-running executor");
  if (vercel && !env.CRON_SECRET) throw new Error("CRON_SECRET is required on Vercel");
  // On Vercel the backend binding (vercel.json) injects BACKEND_URL; locally it is the backend dev server.
  if (production && !env.BACKEND_URL) throw new Error("BACKEND_URL is required in production");
  const backendUrl = env.BACKEND_URL || "http://localhost:8788";
  if (!/^https?:\/\/[^\s]+$/.test(backendUrl)) throw new Error("BACKEND_URL must be an http(s) URL");

  return {
    port: num(env, "PORT", 8787),
    production,
    vercel,
    backendUrl,
    frozenConfigurationHash: hex("FROZEN_CONFIGURATION_HASH", env.FROZEN_CONFIGURATION_HASH, 32),
    account: hex("HL_ACCOUNT", env.HL_ACCOUNT, 20),
    apiWalletKey,
    dryRun,
    slippageBps: num(env, "SLIPPAGE_BPS", 50),
    minOrderUsd: num(env, "MIN_ORDER_USD", 10),
    driftFraction: num(env, "DRIFT_FRACTION", 0.1),
    // A leg trades only if its gap is also ≥ this share of equity (shared/rebalance.ts).
    equityBandFraction: num(env, "EQUITY_BAND_FRACTION", 0.005),
    marginCap: num(env, "MARGIN_CAP", 0.95),
    maxGrossLeverage: num(env, "MAX_GROSS_LEVERAGE", 10),
    adminToken: env.ADMIN_TOKEN || undefined,
    cronSecret: env.CRON_SECRET || undefined,
    telegramBotToken: env.TELEGRAM_BOT_TOKEN || undefined,
    telegramChatId: env.TELEGRAM_CHAT_ID || undefined,
    missedRunAlertMinutes: num(env, "MISSED_RUN_ALERT_MINUTES", 25),
    runTtlSeconds: num(env, "RUN_TTL_SECONDS", 300),
    runTimeoutMs: num(env, "RUN_TIMEOUT_SECONDS", 60) * 1000,
    // Ignored unless dry run: sizes the plan as if our account held this much.
    dryRunEquityUsd: dryRun && env.DRY_RUN_EQUITY_USD ? num(env, "DRY_RUN_EQUITY_USD", 0) : undefined,
  };
};

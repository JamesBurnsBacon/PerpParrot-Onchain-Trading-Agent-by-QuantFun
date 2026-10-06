import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { parsePortfolio } from "../score/parse";
import { runPointInTimeBacktest, type BacktestSource } from "./point-in-time";

const INFO = "https://api.hyperliquid.xyz/info";
const LEADERBOARD = "https://stats-data.hyperliquid.xyz/Mainnet/leaderboard";
const DAY = 86_400_000;
const REQUEST_TIMEOUT_MS = 15_000;

type LeaderboardRow = { ethAddress?: unknown; accountValue?: unknown };
const fail = (message: string): never => { throw new Error(message); };

async function jsonFetch(url: string, init?: RequestInit): Promise<{ body: unknown; sha256: string }> {
  const response = await fetch(url, { ...init, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  if (!response.ok) fail(`HTTP ${response.status} from ${url}`);
  const text = await response.text();
  return { body: JSON.parse(text), sha256: createHash("sha256").update(text).digest("hex") };
}

// Fixed-seed Fisher-Yates keeps the cohort selection reproducible without picking winners by current ROI.
function cohort(rows: unknown[], count: number, seed: number): string[] {
  const candidates = rows.flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const row = item as LeaderboardRow;
    return typeof row.ethAddress === "string" && /^0x[\da-f]{40}$/i.test(row.ethAddress) &&
      typeof row.accountValue === "string" && Number.isFinite(Number(row.accountValue)) && Number(row.accountValue) >= 10_000
      ? [row.ethAddress.toLowerCase()] : [];
  });
  let state = seed >>> 0;
  const random = () => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state / 2 ** 32; };
  for (let i = candidates.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [candidates[i], candidates[j]] = [candidates[j], candidates[i]];
  }
  return candidates.slice(0, count);
}

async function portfolio(address: string): Promise<{ source: BacktestSource; responseHash: string }> {
  const { body, sha256 } = await jsonFetch(INFO, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ type: "portfolio", user: address }),
  });
  const month = parsePortfolio(body).month;
  if (!month) throw new Error(`no monthly portfolio history for ${address}`);
  return { source: { address, month }, responseHash: sha256 };
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const output = new Array<R>(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const index = next++;
      if (index >= items.length) return;
      output[index] = await fn(items[index]);
    }
  }));
  return output;
}

async function main(): Promise<void> {
  const requested = Number(process.env.BACKTEST_SAMPLE_SIZE ?? 40);
  const finalistCount = Number(process.env.BACKTEST_FINALISTS ?? 5);
  const seed = Number(process.env.BACKTEST_SEED ?? 20261006);
  if (!Number.isSafeInteger(requested) || requested < 7 || requested > 100 || !Number.isSafeInteger(finalistCount) || finalistCount < 1 || finalistCount >= requested) {
    fail("sample size must be 7–100; finalist count must be positive and below the sample size");
  }
  const lb = await jsonFetch(LEADERBOARD);
  if (!lb.body || typeof lb.body !== "object" || !Array.isArray((lb.body as { leaderboardRows?: unknown }).leaderboardRows)) fail("unexpected leaderboard payload");
  const addresses = cohort((lb.body as { leaderboardRows: unknown[] }).leaderboardRows, requested, seed);
  const responses = await mapLimit(addresses, 4, async (address) => {
    try { return await portfolio(address); }
    catch (error) { return { error: error instanceof Error ? error.message : String(error), address }; }
  });
  const collected = responses.filter((item): item is { source: BacktestSource; responseHash: string } => "source" in item);
  if (collected.length < finalistCount + 2) fail(`only ${collected.length}/${requested} sources had valid monthly data; need at least ${finalistCount + 2}`);
  const sources = collected.map(({ source }) => source);
  const latestCommonMs = Math.min(...sources.map(({ month }) => month.accountValueHistory.at(-1)![0]));
  const result = runPointInTimeBacktest(sources, {
    asOfMs: latestCommonMs,
    cutoffMs: latestCommonMs - 14 * DAY,
    finalists: finalistCount,
  });
  const report = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    provider: { leaderboard: LEADERBOARD, portfolio: INFO, access: "public read-only; no credentials" },
    methodology: { sampleSeed: seed, requestedSample: requested, finalistCount, minimumAccountValueUsd: 10_000, cutoffRule: "earliest last-observation timestamp across accepted cohort minus 14 days" },
    provenance: { leaderboardSha256: lb.sha256, acceptedPortfolioHashes: Object.fromEntries(collected.map(({ source, responseHash }) => [source.address, responseHash])) },
    rejected: responses.filter((item): item is { error: string; address: string } => "error" in item),
    result,
    raw: sources,
  };
  const target = process.env.BACKTEST_OUTPUT ?? join(process.cwd(), "work", "backtests", `public-${new Date().toISOString().replaceAll(":", "-")}.json`);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, `${JSON.stringify(report, null, 2)}\n`, { flag: "wx" });
  console.log(JSON.stringify({ output: target, requested, accepted: collected.length, rejected: report.rejected.length, cutoff: new Date(result.cutoffMs).toISOString(), asOf: new Date(result.asOfMs).toISOString(), selectedMedianReturn: result.selectedMedianReturn, cohortMedianReturn: result.cohortMedianReturn, selectedOutperformanceBps: result.selectedOutperformanceBps, limitations: result.limitations }, null, 2));
}

main().catch((error) => { console.error(error instanceof Error ? error.message : error); process.exitCode = 1; });

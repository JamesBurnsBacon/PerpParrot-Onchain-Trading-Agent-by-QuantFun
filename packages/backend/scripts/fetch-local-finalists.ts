// Fetch real accounts from Hyperliquid's public API into a JSON file the local backend can score
// (PARROT_FINALISTS_FILE). Read-only: public endpoints only, no database, nothing is written but the output file.
//
//   bun run scripts/fetch-local-finalists.ts [--out <file>] [--traders 60] [--prod-url https://perpparrot.vercel.app]
//
// The pool is the production leaderboard filters (pickLeaderboard) plus the production pipeline's current finalists
// (read with one public GET). It is smaller than the production pool, so Score may pick different finalists than production.
import { writeFileSync } from "node:fs";
import { fillStats, pickLeaderboard, scoringWindows, type Fill, type LeaderboardRow } from "../src/pipeline/derive";
import { PacedInfo, getJson } from "../src/pipeline/hl";
import type { TrackedAccountRow } from "../src/chat/finalists";

const arg = (name: string, fallback: string) => { const i = process.argv.indexOf(name); return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback; };
const out = arg("--out", "/tmp/parrot-local/finalists.json");
const traders = Number(arg("--traders", "60"));
const prodUrl = arg("--prod-url", "https://perpparrot.vercel.app");
if (!Number.isInteger(traders) || traders < 1 || traders > 400) { console.error("--traders must be an integer from 1 to 400"); process.exit(2); }

const HOUR = 3_600_000;
const board = await getJson<{ leaderboardRows: LeaderboardRow[] }>("https://stats-data.hyperliquid.xyz/Mainnet/leaderboard");
const picked = pickLeaderboard(board.leaderboardRows, traders, new Set());
const byAddress = new Map(picked.map(t => [t.address, { address: t.address, kind: t.kind, accountValue: t.accountValue, closed: t.closed as boolean | null }]));

// The production pipeline's current finalists, so the local pool contains the wallets production actually looks at.
type Pipeline = { latest?: { finalists?: { finalists?: { address: string; kind?: string }[] } | null } | null };
try {
  const res = await fetch(`${prodUrl}/api/backend/pipeline`, { signal: AbortSignal.timeout(30_000) });
  if (res.ok) for (const f of ((await res.json()) as Pipeline).latest?.finalists?.finalists ?? []) {
    const address = f.address.toLowerCase();
    if (!byAddress.has(address)) byAddress.set(address, { address, kind: f.kind === "hypercore-vault" ? "hypercore-vault" : "trader", accountValue: NaN, closed: null });
  }
} catch { console.error("note: could not read the production finalists; using the leaderboard only"); }

// Account value from the portfolio's latest point when the leaderboard did not supply one (vaults).
const latestValue = (portfolio: unknown): number => {
  const month = Array.isArray(portfolio) ? portfolio.find(w => Array.isArray(w) && w[0] === "month") : undefined;
  const history = (month as [string, { accountValueHistory?: [number, string][] }] | undefined)?.[1]?.accountValueHistory;
  const last = history?.at(-1);
  return last ? Number(last[1]) : NaN;
};

const hl = new PacedInfo(800);
const now = Date.now();
const rows: TrackedAccountRow[] = [];
let done = 0;
for (const t of byAddress.values()) {
  try {
    const portfolio = scoringWindows(await hl.post<unknown>({ type: "portfolio", user: t.address }));
    const fills = await hl.post<Fill[]>({ type: "userFillsByTime", user: t.address, startTime: now - 30 * 24 * HOUR, aggregateByTime: true }, 20, f => f.length);
    const { tradeCount, makerShare } = fillStats(fills, now);
    const accountValue = Number.isFinite(t.accountValue) ? t.accountValue : latestValue(portfolio);
    if (Number.isFinite(accountValue)) rows.push({ address: t.address, kind: t.kind, account_value: accountValue, closed: t.closed, portfolio, trade_count: tradeCount, maker_share: makerShare });
  } catch (error) { console.error(`skip ${t.address.slice(0, 8)}: ${(error as Error).message}`); }
  if (++done % 10 === 0) console.log(`${done}/${byAddress.size} accounts read`);
}
writeFileSync(out, JSON.stringify(rows));
console.log(`wrote ${rows.length} accounts to ${out}`);

// Pure parts of the selection pipeline (docs/ingest/PIPELINE.md): which accounts to track, what
// a refresh keeps and derives from fills, and who counts as a high-frequency trader.

export type Fill = { coin: string; oid: number; px: string; sz: string; crossed: boolean; time: number };

const DAY_MS = 86_400_000;
// The most fills one userFillsByTime request returns.
export const FILLS_PAGE = 2_000;

// Score's inputs from one userFillsByTime read of the last 30 days. A full page is the *oldest*
// 2,000 fills from the start time, and Hyperliquid keeps only the 10,000 newest, so a full page
// means at least 2,000 fills in its own span (README §4.1):
// - tradeCount: distinct filled (coin, oid), partial fills once (Score SPEC `minTrades`). With a
//   full page it is a lower bound, which is enough for a minimum.
// - makerShare: maker notional / notional over the fills read; null without fills.
// - ordersPerDay: distinct orders per day over the span the fills cover: 30 days, or the page's
//   own span when it is full. null without fills.
export const fillStats = (fills: Fill[], nowMs: number): { tradeCount: number; makerShare: number | null; ordersPerDay: number | null } => {
  const orders = new Set(fills.map((f) => `${f.coin}:${f.oid}`));
  const times = fills.map((f) => f.time);
  const spanDays = fills.length >= FILLS_PAGE ? Math.max((Math.max(...times) - Math.min(...times)) / DAY_MS, 1 / 24) : 30;
  let maker = 0;
  let total = 0;
  for (const f of fills) {
    if (f.time < nowMs - 30 * DAY_MS) continue;
    const notional = Math.abs(Number(f.px) * Number(f.sz));
    if (!Number.isFinite(notional)) continue;
    total += notional;
    if (!f.crossed) maker += notional;
  }
  return { tradeCount: orders.size, makerShare: total > 0 ? maker / total : null, ordersPerDay: fills.length ? orders.size / spanDays : null };
};

// A 10-minute copy loop can't follow a source that places more orders than this a day.
export const MAX_ORDERS_PER_DAY = 100;
export const isHighFrequency = (ordersPerDay: number | null): boolean => ordersPerDay !== null && ordersPerDay > MAX_ORDERS_PER_DAY;

// The portfolio windows Score reads (score/parse.ts); the other six are dropped before storing.
export const scoringWindows = (portfolio: unknown): unknown =>
  Array.isArray(portfolio) ? portfolio.filter((w) => Array.isArray(w) && (w[0] === "month" || w[0] === "allTime")) : portfolio;

// Same addresses, in any order.
export const sameAddresses = (a: readonly string[], b: readonly string[]): boolean => {
  const set = new Set(a.map((x) => x.toLowerCase()));
  return set.size === new Set(b.map((x) => x.toLowerCase())).size && b.every((x) => set.has(x.toLowerCase()));
};

// A re-review that keeps the active wallets replaces the configuration only if some weight moved by
// more than this (owner, 2026-10-07: 5 percentage points), so small re-weightings don't churn the book.
export const WEIGHT_REFRESH_UNITS = 50_000; // of 1e6

// The active configuration still stands: the same wallets, and no weight moved by more than the threshold.
export const keepsActive = (
  active: readonly { sourceAddress: string; weightUnits: number }[],
  next: readonly { sourceAddress: string; weightUnits: number }[],
  thresholdUnits = WEIGHT_REFRESH_UNITS,
): boolean => {
  if (!sameAddresses(active.map((s) => s.sourceAddress), next.map((s) => s.sourceAddress))) return false;
  const weights = new Map(active.map((s) => [s.sourceAddress.toLowerCase(), s.weightUnits]));
  return next.every((s) => Math.abs(s.weightUnits - (weights.get(s.sourceAddress.toLowerCase()) ?? 0)) <= thresholdUnits);
};

export type LeaderboardRow = {
  ethAddress: string;
  accountValue: string;
  displayName: string | null;
  windowPerformances: [string, { pnl: string; roi: string; vlm: string }][];
};

export type Tracked = {
  address: string;
  source: "leaderboard" | "vault";
  kind: "trader" | "hypercore-vault";
  name: string | null;
  accountValue: number;
  closed: boolean | null;
  primary: boolean; // hyperliquidvaults.com or the leaderboard's top 200: refreshed first
};

// The leaderboard's top traders by month PnL that count as primary sources.
export const PRIMARY_TRADERS = 200;

// Leaderboard traders with ≥ $10k account value and positive month and all-time PnL, by month
// PnL (README §4.1 cheap filters). The scan keeps all of them (~13k); the top 200 are primary.
export const pickLeaderboard = (rows: LeaderboardRow[], count: number, exclude: ReadonlySet<string>): Tracked[] => {
  const pnl = (row: LeaderboardRow, window: string) => Number(row.windowPerformances.find(([w]) => w === window)?.[1].pnl ?? NaN);
  return rows
    .map((row) => ({ row, month: pnl(row, "month"), allTime: pnl(row, "allTime"), value: Number(row.accountValue) }))
    .filter(({ row, month, allTime, value }) => value >= 10_000 && month > 0 && allTime > 0 && !exclude.has(row.ethAddress.toLowerCase()))
    .sort((a, b) => b.month - a.month)
    .slice(0, count)
    .map(({ row, value }, i) => ({
      address: row.ethAddress.toLowerCase(),
      source: "leaderboard",
      kind: "trader",
      name: row.displayName,
      accountValue: value,
      closed: false,
      primary: i < PRIMARY_TRADERS,
    }));
};

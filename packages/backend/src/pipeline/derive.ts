// Pure parts of the selection pipeline (docs/ingest/PIPELINE.md): which accounts to track, what
// a refresh derives from fills, and when a selection is due.

export type Fill = { coin: string; oid: number; px: string; sz: string; crossed: boolean; time: number };

const DAY_MS = 86_400_000;

// Score's inputs from one read of fills (newest up to 2,000; README §4.1):
// - tradeCount: distinct filled (coin, oid), partial fills once (Score SPEC `minTrades`). With a
//   full page it is a lower bound, which is enough for a minimum.
// - makerShare: maker notional / notional over the last 30 days; null without fills then.
export const fillStats = (fills: Fill[], nowMs: number): { tradeCount: number; makerShare: number | null } => {
  const orders = new Set(fills.map((f) => `${f.coin}:${f.oid}`));
  let maker = 0;
  let total = 0;
  for (const f of fills) {
    if (f.time < nowMs - 30 * DAY_MS) continue;
    const notional = Math.abs(Number(f.px) * Number(f.sz));
    if (!Number.isFinite(notional)) continue;
    total += notional;
    if (!f.crossed) maker += notional;
  }
  return { tradeCount: orders.size, makerShare: total > 0 ? maker / total : null };
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
};

// The leaderboard's top `count` traders: ≥ $10k account value, positive month and all-time PnL,
// ranked by month PnL (active, currently profitable traders; README §4.1 cheap filters).
export const pickLeaderboard = (rows: LeaderboardRow[], count: number, exclude: ReadonlySet<string>): Tracked[] => {
  const pnl = (row: LeaderboardRow, window: string) => Number(row.windowPerformances.find(([w]) => w === window)?.[1].pnl ?? NaN);
  return rows
    .map((row) => ({ row, month: pnl(row, "month"), allTime: pnl(row, "allTime"), value: Number(row.accountValue) }))
    .filter(({ row, month, allTime, value }) => value >= 10_000 && month > 0 && allTime > 0 && !exclude.has(row.ethAddress.toLowerCase()))
    .sort((a, b) => b.month - a.month)
    .slice(0, count)
    .map(({ row, value }) => ({
      address: row.ethAddress.toLowerCase(),
      source: "leaderboard",
      kind: "trader",
      name: row.displayName,
      accountValue: value,
      closed: false,
    }));
};

// Twice a day (06:00 and 18:00 UTC): the latest slot at or before now.
export const SELECTION_HOURS_UTC = [6, 18];
export const latestSlot = (nowMs: number): number => {
  const day = Math.floor(nowMs / DAY_MS) * DAY_MS;
  const slots = [-1, 0].flatMap((d) => SELECTION_HOURS_UTC.map((h) => day + d * DAY_MS + h * 3_600_000));
  return Math.max(...slots.filter((s) => s <= nowMs));
};

// A selection is due once per slot. The first run after deploy counts for the slot it's in, and a
// failed run (not a rejection) is retried after 30 minutes.
export const selectionDue = (nowMs: number, runs: { startedAt: number; status: string }[]): boolean => {
  const slot = latestSlot(nowMs);
  if (runs.some((r) => r.startedAt >= slot && r.status !== "failed")) return false;
  return !runs.some((r) => r.startedAt > nowMs - 30 * 60_000);
};

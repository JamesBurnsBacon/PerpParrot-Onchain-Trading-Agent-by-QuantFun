// One account's study record, built only from cached-or-fetched HL responses. Shared by fetch.ts (online) and
// analyze.ts (offline), so both apply the same selection rules.
//
// Timeline per account: t0 = first point of its `portfolio` month window (≈ now − 30 d).
//   formation [t0 − 30 d, t0): maker share from fills, past performance from the allTime window
//   forward   [t0, now]:       outcome, from the month window (~45 points, 16–22 h apart)
// Selection only uses data from before t0, so the forward window is out of sample.
import { parsePortfolio } from "../../../packages/backend/src/score/parse";
import { DAY_MS, makerStats, performance, windowPoints, type Fill, type MakerStats, type Performance } from "./features";
import type { Client } from "./hl";

export const FORMATION_DAYS = 30;
export const MIN_ACCOUNT_VALUE = 10_000; // README §4.2 hard filters, applied at t0
export const MIN_ACTIVE_DAYS = 30;
export const MIN_TRADES = 10;
export const MIN_MONTH_POINTS = 25;
const FILLS_PAGE = 2000; // userFillsByTime returns at most this many, oldest first

export type LeaderboardRow = {
  ethAddress: string;
  accountValue: string;
  windowPerformances: [string, { pnl: string; roi: string; vlm: string }][];
};

export type Rejection = "portfolioError" | "monthPoints" | "accountValue" | "history" | "formationTrades";

export type Account = {
  address: string;
  kind: "trader" | "vault";
  monthVlm: number; // leaderboard, for describing rejected accounts only
  status: "ok" | Rejection;
  t0?: number;
  accountValue0?: number;
  maker?: MakerStats;
  fillsCapped?: boolean; // a formation chunk returned a full page, so its later fills were not seen
  formation?: Performance | null;
  forward?: Performance | null;
};

export const windowOf = (row: LeaderboardRow, name: string) =>
  Object.fromEntries(row.windowPerformances)[name] as { pnl: string; roi: string; vlm: string } | undefined;

// lagDays = 30 replays the same test one period earlier (a second market regime): t0 moves back 30 days and the
// forward window comes from the coarse allTime points instead of month, so only its return is meaningful.
export const loadAccount = async (
  client: Client,
  row: LeaderboardRow,
  vaults: Set<string>,
  lagDays = 0,
): Promise<Account> => {
  const address = row.ethAddress.toLowerCase();
  const base = {
    address,
    kind: vaults.has(address) ? ("vault" as const) : ("trader" as const),
    monthVlm: Number(windowOf(row, "month")?.vlm ?? 0),
  };
  let parsed: ReturnType<typeof parsePortfolio>;
  try {
    parsed = parsePortfolio(await client.info({ type: "portfolio", user: address }));
  } catch (error) {
    if (String(error).includes("offline")) throw error;
    return { ...base, status: "portfolioError" };
  }
  const { month, allTime } = parsed;
  if (!month || month.accountValueHistory.length < MIN_MONTH_POINTS) return { ...base, status: "monthPoints" };
  const monthStart = month.accountValueHistory[0][0];
  const lagged = lagDays > 0 && allTime ? allTime.accountValueHistory.filter(([ts]) => ts <= monthStart - lagDays * DAY_MS) : [];
  if (lagDays > 0 && !lagged.length) return { ...base, status: "history" };
  const [t0, accountValue0] = lagDays > 0 ? lagged.at(-1)! : month.accountValueHistory[0];
  const end = lagDays > 0
    ? allTime!.accountValueHistory.filter(([ts]) => ts <= monthStart).at(-1)![0]
    : month.accountValueHistory[month.accountValueHistory.length - 1][0];
  if (accountValue0 < MIN_ACCOUNT_VALUE) return { ...base, status: "accountValue", t0, accountValue0 };
  const firstActive = allTime?.accountValueHistory.find(([, v]) => v > 0)?.[0];
  if (firstActive === undefined || firstActive > t0 - MIN_ACTIVE_DAYS * DAY_MS) {
    return { ...base, status: "history", t0, accountValue0 };
  }

  // Two half-window chunks, one page each, so heavy accounts are sampled across the window, not just its start.
  const start = t0 - FORMATION_DAYS * DAY_MS;
  const mid = t0 - (FORMATION_DAYS / 2) * DAY_MS;
  const chunks = await Promise.all(
    [[start, mid - 1], [mid, t0 - 1]].map(([startTime, endTime]) =>
      client.info<Fill[]>({ type: "userFillsByTime", user: address, startTime, endTime, aggregateByTime: true }),
    ),
  );
  const maker = makerStats(chunks.flat());
  const fillsCapped = chunks.some((c) => c.length >= FILLS_PAGE);
  if (maker.fills < MIN_TRADES) return { ...base, status: "formationTrades", t0, accountValue0, maker, fillsCapped };

  // allTime is coarse, so start from its last point at or before the formation start.
  const formationFrom = allTime!.accountValueHistory.filter(([ts]) => ts <= start).at(-1)?.[0] ?? start;
  return {
    ...base,
    status: "ok",
    t0,
    accountValue0,
    maker,
    fillsCapped,
    formation: performance(windowPoints(allTime!, formationFrom, t0)),
    forward: performance(windowPoints(lagDays > 0 ? allTime! : month, t0, end)),
  };
};

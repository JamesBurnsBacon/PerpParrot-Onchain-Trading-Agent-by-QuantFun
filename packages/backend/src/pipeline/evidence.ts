// Measured evidence for the AI review (docs/ingest/PIPELINE.md PR D): the frame fields the review
// core's strict gate requires and Score doesn't produce. Computed at selection time for each
// finalist from its last 30 days of fills, its month portfolio history and its live positions.
// Unknown stays null, never made up.
//
// "Out-of-sample" here is two fixed trailing 7-day holdouts (oldest first, no best-window search).
// They are also inside Score's own lookback, so read them as recent performance, not as a
// point-in-time test.
import { computeIntervals } from "../score/returns";
import { DEFAULT_CONFIG } from "../score/config";
import type { ScoreInput } from "../score/types";
import type { LivePosition } from "../../review/input.ts";

export type HlFill = {
  coin: string;
  oid: number;
  px: string;
  sz: string;
  side: "B" | "A";
  startPosition: string;
  crossed: boolean;
  time: number;
};

export type Measured = {
  averageLeverage: number | null;
  timeInMarket: number | null;
  medianHoldMinutes: number | null;
  oosWindows: number;
  oosSharpe: number | null;
  oosSortino: number | null;
  oosMaxDrawdown: number | null;
  crossWindowStability: number | null;
  executionCoverage: number | null;
  executionFit: number | null;
  concentration: number | null;
  liquidationDistance: number | null;
};

const DAY = 86_400_000;
const MINUTE = 60_000;
export const EVIDENCE_DAYS = 30;
const HOLDOUT_DAYS = 7;
const MIN_HOLDOUT_INTERVALS = 4;
const RATIO_CAP = 10; // a holdout without downside would otherwise be infinite

const isPerp = (coin: string) => !coin.startsWith("@") && !coin.includes("/");
const median = (xs: number[]): number | null => {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
};
const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x));

type Episode = { coin: string; open: number; close: number | null; carriedIn: boolean };

// Positions per coin from fills: Hyperliquid reports each fill's position before it
// (startPosition), so an episode opens when a position leaves zero and closes when it returns to
// zero or flips. A position already open at the window start is carried in (its hold is unknown).
export const episodesFromFills = (fills: HlFill[], windowStart: number): Episode[] => {
  const byCoin = new Map<string, HlFill[]>();
  for (const f of fills) if (isPerp(f.coin)) (byCoin.get(f.coin) ?? byCoin.set(f.coin, []).get(f.coin)!).push(f);
  const episodes: Episode[] = [];
  for (const [coin, list] of byCoin) {
    list.sort((a, b) => a.time - b.time);
    let open: Episode | undefined;
    const first = Number(list[0]!.startPosition);
    if (first !== 0) open = { coin, open: windowStart, close: null, carriedIn: true };
    for (const f of list) {
      const before = Number(f.startPosition);
      const after = before + (f.side === "B" ? 1 : -1) * Number(f.sz);
      if (!Number.isFinite(before) || !Number.isFinite(after)) continue;
      if (before === 0 && after !== 0) open = { coin, open: f.time, close: null, carriedIn: false };
      else if (before !== 0 && (after === 0 || Math.sign(after) !== Math.sign(before))) {
        if (open) episodes.push({ ...open, close: f.time });
        open = after === 0 ? undefined : { coin, open: f.time, close: null, carriedIn: false };
      }
    }
    if (open) episodes.push(open);
  }
  return episodes;
};

// Median hold of closed episodes. With none closed, the open episodes' ages are a lower bound
// (a carried-in position has been held at least the whole window).
export const holdMinutes = (episodes: Episode[], nowMs: number): number | null => {
  const closed = episodes.filter((e) => e.close !== null && !e.carriedIn).map((e) => (e.close! - e.open) / MINUTE);
  if (closed.length) return median(closed);
  const open = episodes.filter((e) => e.close === null).map((e) => (nowMs - e.open) / MINUTE);
  return median(open);
};

// Share of the window with any position open (episodes plus positions held throughout).
export const timeInMarket = (episodes: Episode[], heldThroughout: boolean, windowStart: number, nowMs: number): number | null => {
  if (heldThroughout) return 1;
  const spans = episodes.map((e) => [Math.max(e.open, windowStart), e.close ?? nowMs] as const).sort((a, b) => a[0] - b[0]);
  let covered = 0;
  let end = windowStart;
  for (const [s, e] of spans) {
    if (e <= end) continue;
    covered += e - Math.max(s, end);
    end = e;
  }
  return clamp(covered / (nowMs - windowStart), 0, 1);
};

// Average gross leverage over the window, sampled at each month-history point: positions from the
// fills (last fill price as the mark), plus positions open today with no fills (constant notional).
export const averageLeverage = (fills: HlFill[], input: ScoreInput, positions: LivePosition[], windowStart: number, nowMs: number): number | null => {
  const history = input.month?.accountValueHistory.filter(([t]) => t >= windowStart && t <= nowMs) ?? [];
  if (history.length === 0) return null;
  const byCoin = new Map<string, HlFill[]>();
  for (const f of [...fills].sort((a, b) => a.time - b.time)) if (isPerp(f.coin)) (byCoin.get(f.coin) ?? byCoin.set(f.coin, []).get(f.coin)!).push(f);
  const untouched = positions.filter((p) => !byCoin.has(p.market)).reduce((s, p) => s + Math.abs(p.signedNotionalUsd), 0);
  const samples: number[] = [];
  for (const [t, value] of history) {
    if (!(value > 0)) continue;
    let gross = untouched;
    for (const coinFills of byCoin.values()) {
      let last: HlFill | undefined;
      for (const f of coinFills) if (f.time <= t) last = f; else break;
      const size = last ? Number(last.startPosition) + (last.side === "B" ? 1 : -1) * Number(last.sz) : Number(coinFills[0]!.startPosition);
      const px = Number((last ?? coinFills[0]!).px);
      if (Number.isFinite(size) && Number.isFinite(px)) gross += Math.abs(size * px);
    }
    samples.push(gross / value);
  }
  return samples.length ? samples.reduce((a, b) => a + b, 0) / samples.length : null;
};

type Window = { mean: number; sd: number; downside: number; ret: number; drawdown: number; intervals: number };

// Score's daily ratios (score/metrics.ts) over one holdout of the month history.
const holdout = (input: ScoreInput, from: number, to: number): Window | null => {
  const month = input.month;
  if (!month) return null;
  const points = month.accountValueHistory
    .map(([ts, accountValue], i) => ({ ts, accountValue, pnl: month.pnlHistory[i]?.[1] ?? NaN }))
    .filter((p) => p.ts >= from - DAY && p.ts <= to && Number.isFinite(p.pnl));
  const { intervals } = computeIntervals(points, DEFAULT_CONFIG.dustEquityFraction);
  const used = intervals.filter((i) => i.used && i.end > from && i.end <= to);
  if (used.length < MIN_HOLDOUT_INTERVALS) return null;
  const time = used.reduce((s, i) => s + i.dt, 0);
  if (!(time > 0)) return null;
  const mean = used.reduce((s, i) => s + i.r, 0) / time;
  const sd = Math.sqrt(used.reduce((s, i) => s + (i.r - mean * i.dt) ** 2, 0) / time);
  const downside = Math.sqrt(used.reduce((s, i) => s + Math.min(i.r, 0) ** 2, 0) / time);
  let value = 1;
  let peak = 1;
  let drawdown = 0;
  for (const i of used) {
    value *= 1 + i.r;
    peak = Math.max(peak, value);
    drawdown = Math.max(drawdown, (peak - value) / peak);
  }
  return { mean, sd, downside, ret: value - 1, drawdown: clamp(drawdown, 0, 1), intervals: used.length };
};

const capped = (numerator: number, denominator: number): number =>
  denominator > 0 ? clamp(numerator / denominator, -RATIO_CAP, RATIO_CAP) : numerator > 0 ? RATIO_CAP : numerator < 0 ? -RATIO_CAP : 0;

export const holdouts = (input: ScoreInput, nowMs: number) => {
  const windows = [
    holdout(input, nowMs - 2 * HOLDOUT_DAYS * DAY, nowMs - HOLDOUT_DAYS * DAY),
    holdout(input, nowMs - HOLDOUT_DAYS * DAY, nowMs),
  ].filter((w): w is Window => w !== null);
  if (windows.length === 0) return { oosWindows: 0, oosSharpe: null, oosSortino: null, oosMaxDrawdown: null, crossWindowStability: null };
  const time = windows.reduce((s, w) => s + w.intervals, 0);
  const mean = windows.reduce((s, w) => s + w.mean * w.intervals, 0) / time;
  const sd = Math.sqrt(windows.reduce((s, w) => s + w.sd ** 2 * w.intervals, 0) / time);
  const downside = Math.sqrt(windows.reduce((s, w) => s + w.downside ** 2 * w.intervals, 0) / time);
  // Stability: 0 when the two windows disagree in sign, else the smaller return over the larger.
  let crossWindowStability: number | null = null;
  if (windows.length === 2) {
    const [a, b] = windows.map((w) => w.ret) as [number, number];
    crossWindowStability = Math.sign(a) !== Math.sign(b) ? 0 : a === b ? 1 : Math.min(Math.abs(a), Math.abs(b)) / Math.max(Math.abs(a), Math.abs(b));
  }
  return {
    oosWindows: windows.length,
    oosSharpe: capped(mean, sd),
    oosSortino: capped(mean, downside),
    oosMaxDrawdown: Math.max(...windows.map((w) => w.drawdown)),
    crossWindowStability,
  };
};

// Copyability for a 10-minute loop, 0–100: tradable share of traded notional × the share of a
// typical holding a copy that starts up to 10 minutes late still catches (1 − 10 min / median
// hold) × how often it trades (≤ 20 orders a day → 1, falling to 0.5 at 100). The review core
// separately requires holds ≥ 60 min and discounts holds under 6 h.
export const executionFit = (coverage: number | null, holdMins: number | null, ordersPerDay: number | null): number | null => {
  if (coverage === null || holdMins === null) return null;
  const hold = clamp(1 - 10 / Math.max(holdMins, 1), 0, 1);
  const frequency = ordersPerDay === null || ordersPerDay <= 20 ? 1 : clamp(1 - (0.5 * (ordersPerDay - 20)) / 80, 0.5, 1);
  return Math.round(100 * coverage * hold * frequency);
};

// Share of notional in markets the copy loop can trade (≥ $20M open interest, README §4.4): over
// the window's fills, or today's positions when there were none.
export const executionCoverage = (fills: HlFill[], positions: LivePosition[], eligible: ReadonlySet<string>): number | null => {
  const traded = fills.filter((f) => isPerp(f.coin)).map((f) => [f.coin, Math.abs(Number(f.px) * Number(f.sz))] as const);
  const rows = traded.length ? traded : positions.map((p) => [p.market, Math.abs(p.signedNotionalUsd)] as const);
  const total = rows.reduce((s, [, n]) => s + (Number.isFinite(n) ? n : 0), 0);
  if (!(total > 0)) return null;
  return rows.reduce((s, [coin, n]) => s + (eligible.has(coin) && Number.isFinite(n) ? n : 0), 0) / total;
};

export const measure = (args: {
  input: ScoreInput;
  fills: HlFill[];
  positions: LivePosition[];
  eligible: ReadonlySet<string>;
  nowMs: number;
}): Measured => {
  const { input, fills, positions, eligible, nowMs } = args;
  const windowStart = nowMs - EVIDENCE_DAYS * DAY;
  const recent = fills.filter((f) => f.time >= windowStart && f.time <= nowMs);
  const episodes = episodesFromFills(recent, windowStart);
  const traded = new Set(recent.filter((f) => isPerp(f.coin)).map((f) => f.coin));
  const heldThroughout = positions.some((p) => !traded.has(p.market));
  let hold = holdMinutes(episodes, nowMs);
  if (hold === null && heldThroughout) hold = EVIDENCE_DAYS * 24 * 60; // held all window, no trades
  const orders = new Set(recent.map((f) => `${f.coin}:${f.oid}`)).size;
  const coverage = executionCoverage(recent, positions, eligible);
  const gross = positions.reduce((s, p) => s + Math.abs(p.signedNotionalUsd), 0);
  const liquidation = positions.map((p) => p.liquidationDistance).filter((d): d is number => d !== null);
  return {
    averageLeverage: averageLeverage(recent, input, positions, windowStart, nowMs),
    timeInMarket: recent.length || positions.length ? timeInMarket(episodes, heldThroughout, windowStart, nowMs) : null,
    medianHoldMinutes: hold,
    ...holdouts(input, nowMs),
    executionCoverage: coverage,
    executionFit: executionFit(coverage, hold, orders / EVIDENCE_DAYS),
    concentration: gross > 0 ? Math.max(...positions.map((p) => Math.abs(p.signedNotionalUsd))) / gross : null,
    liquidationDistance: liquidation.length ? Math.min(...liquidation) : null,
  };
};

// Today's exposure two sources share: per asset, the smaller of their same-sign weights (each
// position's share of its own gross), summed. 0 when either is flat.
export const exposureOverlap = (a: LivePosition[], b: LivePosition[]): number => {
  const weights = (ps: LivePosition[]) => {
    const gross = ps.reduce((s, p) => s + Math.abs(p.signedNotionalUsd), 0);
    return new Map(gross > 0 ? ps.map((p) => [p.market, p.signedNotionalUsd / gross]) : []);
  };
  const wa = weights(a);
  const wb = weights(b);
  let overlap = 0;
  for (const [market, x] of wa) {
    const y = wb.get(market);
    if (y !== undefined && Math.sign(x) === Math.sign(y)) overlap += Math.min(Math.abs(x), Math.abs(y));
  }
  return clamp(overlap, 0, 1);
};

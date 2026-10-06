import { DEFAULT_CONFIG, validateConfig } from "./config";
import { computeIntervals } from "./returns";
import { buildSeries, DAY_MS, validateSeries } from "./stitch";
import type { Metrics, Ratio, ScoreConfig, ScoreInput, WindowHistory } from "./types";

export type CurvePoint = { ts: number; value: number };
export type Analysis = { metrics: Metrics; curve: CurvePoint[]; fineStart: number; lastTs: number };

const finiteOrNull = (value: number): number | null => Number.isFinite(value) ? value : null;

// A zero denominator is +inf for a positive numerator and undefined otherwise; overflow is null (SPEC "Metrics").
const ratio = (numerator: number | null, denominator: number | null): Ratio => {
  if (numerator === null || denominator === null || !Number.isFinite(numerator) || !Number.isFinite(denominator)) return null;
  return denominator > 0 ? finiteOrNull(numerator / denominator) : numerator > 0 ? "+inf" : null;
};

// Value of the last curve point at or before `ts` (SPEC "Metrics").
export const curveAt = (curve: CurvePoint[], ts: number): number => {
  let value = curve[0].value;
  for (const point of curve) {
    if (point.ts > ts) break;
    value = point.value;
  }
  return value;
};

// The curve value at or before each grid time firstTs + k * step that falls before the first fine interval (SPEC
// "Metrics"). Visiting the curve segments instead of every tick keeps this finite for any step > 0: a segment is
// sampled when a tick falls inside it, in time order, so the drawdown over the samples is the same.
export const gridSamples = (curve: CurvePoint[], firstTs: number, fineStart: number, step: number): number[] => {
  const samples: number[] = [];
  for (let j = 0; j < curve.length && curve[j].ts < fineStart; j++) {
    const from = curve[j].ts;
    const to = Math.min(j + 1 < curve.length ? curve[j + 1].ts : Infinity, fineStart);
    const ticks = (from - firstTs) / step;
    if (!(ticks < 2 ** 52)) {
      samples.push(curve[j].value); // a grid denser than the timestamps can resolve: every segment holds a tick
      continue;
    }
    const tickAt = (k: number): number => k === 0 ? firstTs : firstTs + k * step;
    let k = from > firstTs ? Math.max(1, Math.ceil(ticks)) : 0; // a step that overflows to Infinity leaves only k = 0
    if (k > 1 && tickAt(k - 1) >= from) k -= 1; // `ticks` rounded up past an exact tick
    else if (tickAt(k) < from) k += 1; // or rounded down to a tick just before this segment
    if (Math.max(tickAt(k), from) < to) samples.push(curve[j].value);
  }
  return samples;
};

const maxDrawdownOf = (values: number[]): number => {
  let peak = -Infinity;
  let drawdown = 0;
  for (const value of values) {
    peak = Math.max(peak, value);
    if (peak > 0) drawdown = Math.max(drawdown, (peak - value) / peak);
  }
  return drawdown;
};

// Compound used intervals from C_0 = 1; a loss of 100% or more pins the curve at 0 (SPEC "Metrics").
const compound = (start: number, intervals: { end: number; r: number; used: boolean }[]) => {
  const curve: CurvePoint[] = [{ ts: start, value: 1 }];
  let value = 1;
  let ruin = false;
  for (const { end, r, used } of intervals) {
    if (!used) continue;
    if (ruin || 1 + r <= 0) {
      ruin = true;
      value = 0;
    } else {
      value *= 1 + r;
    }
    curve.push({ ts: end, value });
  }
  return { curve, ruin };
};

// R² of ln(C) against elapsed days, 0 for a falling trend, null for a flat curve (SPEC "Metrics").
const consistencyOf = (curve: CurvePoint[]): number | null => {
  const xs = curve.map(({ ts }) => (ts - curve[0].ts) / DAY_MS);
  const ys = curve.map(({ value }) => Math.log(value));
  const meanX = xs.reduce((sum, x) => sum + x, 0) / xs.length;
  const meanY = ys.reduce((sum, y) => sum + y, 0) / ys.length;
  let sxx = 0;
  let syy = 0;
  let sxy = 0;
  for (let i = 0; i < xs.length; i++) {
    sxx += (xs[i] - meanX) ** 2;
    syy += (ys[i] - meanY) ** 2;
    sxy += (xs[i] - meanX) * (ys[i] - meanY);
  }
  if (syy === 0 || sxx === 0) return null;
  return sxy <= 0 ? 0 : finiteOrNull((sxy * sxy) / (sxx * syy));
};

// Drawdown over the whole allTime window at its own resolution; reported, not ranked (SPEC "Metrics").
const allTimeMaxDrawdown = (allTime: WindowHistory | null, config: ScoreConfig): number | null => {
  if (!validateSeries(allTime)) return null;
  const points = allTime.accountValueHistory.map(([ts, accountValue], i) =>
    ({ ts, accountValue, pnl: allTime.pnlHistory[i][1] }));
  const { intervals } = computeIntervals(points, config.dustEquityFraction);
  if (!intervals.some(({ used }) => used)) return null;
  const { curve } = compound(points[0].ts, intervals);
  return finiteOrNull(maxDrawdownOf(curve.map(({ value }) => value)));
};

const uniqueSorted = (flags: string[]): string[] => [...new Set(flags)].sort();

// Internal: metrics plus the curve that clone grouping samples daily (SPEC "Clone grouping").
export const analyse = (input: ScoreInput, config: ScoreConfig): Analysis | null => {
  const series = buildSeries(input, config);
  if (series === null) return null;
  const { points } = series;
  const { intervals, flags: returnFlags } = computeIntervals(points, config.dustEquityFraction);
  const flags = [...series.flags, ...returnFlags];
  const firstTs = points.length > 0 ? points[0].ts : 0;
  const lastTs = points.length > 0 ? points[points.length - 1].ts : 0;
  const spanMs = lastTs - firstTs;
  const span = spanMs / DAY_MS;
  // Shares are sums of whole milliseconds divided once, so a share exactly at a limit compares exactly.
  const total = intervals.reduce((sum, { start, end }) => sum + (end - start), 0);
  const skipped = intervals.reduce((sum, { start, end, used }) => used ? sum : sum + (end - start), 0);
  const fineTime = intervals.reduce((sum, { start, end, fine }) => fine ? sum + (end - start) : sum, 0);
  const used = intervals.filter((interval) => interval.used);
  const time = used.reduce((sum, { dt }) => sum + dt, 0);
  if (intervals.some(({ fine, dt }) => !fine && dt > 1.5 * config.coarseGridDays)) flags.push("coarse-history");

  const firstFine = intervals.find(({ fine }) => fine);
  const fineStart = firstFine === undefined ? lastTs : firstFine.start;
  const base = {
    allTimeMaxDrawdown: allTimeMaxDrawdown(input.allTime, config),
    lookbackDays: span,
    coveredDays: time,
    skippedTimeShare: total > 0 ? skipped / total : 0,
    fineTimeShare: spanMs > 0 ? fineTime / spanMs : 0,
  };

  if (used.length === 0 || time === 0) {
    flags.push("no-intervals");
    return {
      metrics: {
        sharpe: null, sortino: null, calmar: null, maxDrawdown: null, consistency: null, periodReturn: null,
        annualisedReturn: null, annualisedVol: null, realizedVol: null, ...base, flags: uniqueSorted(flags),
      },
      curve: [{ ts: firstTs, value: 1 }],
      fineStart,
      lastTs,
    };
  }
  if (base.skippedTimeShare > config.maxSkippedTimeShare) flags.push("low-coverage");

  const mean = used.reduce((sum, { r }) => sum + r, 0) / time;
  const sd = Math.sqrt(used.reduce((sum, { r, dt }) => sum + (r - mean * dt) ** 2, 0) / time);
  const downside = Math.sqrt(used.reduce((sum, { r }) => sum + Math.min(r, 0) ** 2, 0) / time);
  if (downside === 0 && mean > 0) flags.push("no-downside");

  const { curve, ruin } = compound(firstTs, intervals);
  if (ruin) flags.push("ruin");
  const last = curve[curve.length - 1].value;
  const periodReturn = last - 1;

  // Coarse part on a common grid so allTime resolution does not decide the drawdown (SPEC "Metrics").
  const drawdownPoints: number[] = [];
  drawdownPoints.push(...gridSamples(curve, firstTs, fineStart, config.coarseGridDays * DAY_MS));
  drawdownPoints.push(curveAt(curve, fineStart));
  for (const point of curve) if (point.ts > fineStart) drawdownPoints.push(point.value);
  const maxDrawdown = finiteOrNull(maxDrawdownOf(drawdownPoints));
  if (maxDrawdown === 0 && periodReturn > 0) flags.push("no-drawdown");

  return {
    metrics: {
      sharpe: ratio(mean, sd),
      sortino: ratio(mean, downside),
      calmar: ratio(finiteOrNull(periodReturn), maxDrawdown),
      maxDrawdown,
      consistency: ruin ? null : consistencyOf(curve),
      periodReturn: finiteOrNull(periodReturn),
      annualisedReturn: ruin ? -1 : finiteOrNull(last ** (365 / time) - 1),
      annualisedVol: finiteOrNull(sd * Math.sqrt(365)),
      realizedVol: finiteOrNull(sd),
      ...base,
      flags: uniqueSorted(flags),
    },
    curve,
    fineStart,
    lastTs,
  };
};

// Metrics for one input; null when the month window is missing or invalid (SPEC "Metrics").
export const computeMetrics = (input: ScoreInput, config: Partial<ScoreConfig> = {}): Metrics | null => {
  const resolved = { ...DEFAULT_CONFIG, ...config };
  validateConfig(resolved);
  return analyse(input, resolved)?.metrics ?? null;
};

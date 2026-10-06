import { computeIntervals } from '../packages/backend/src/score/returns.ts';
import { buildSeries, DAY_MS } from '../packages/backend/src/score/stitch.ts';
import { DEFAULT_CONFIG } from '../packages/backend/src/score/config.ts';
import type { ScoreInput } from '../packages/backend/src/score/types.ts';
import { allocationSchema, type Algorithm, type Allocation } from './contracts.ts';

export type Point = {ts: number; accountValue: number; pnl: number; fine?: boolean};
export type History = {address: string; points: Point[]};
export type Candidate = {address: string; trainReturn: number; trainDrawdown: number; capitalUsd: number};
export const DAY = DAY_MS;
export const WINDOWS = [14, 30, 42, 90] as const;
export const ALGORITHMS: Algorithm[] = ['return-first.v1', 'drawdown-first.v1'];

export function history(input: ScoreInput): History | null {
  // Same stitching checks as production; retain the archive's long lookback.
  const series = buildSeries(input, {...DEFAULT_CONFIG, lookbackDays: 10_000});
  if (!series || series.flags.some(f => f.includes('mismatch')) || series.points.some(p =>
    !Number.isFinite(p.pnl) || !Number.isFinite(p.accountValue) || p.accountValue < 0)) return null;
  return {address: input.address.toLowerCase(), points: series.points};
}
export function windowStats(points: Point[], from: number, through: number) {
  // Never prorate an interval crossing the boundary; report actual coverage.
  const cut = points.filter(p => p.ts >= from && p.ts <= through);
  const {intervals} = computeIntervals(cut, 0.01);
  if (cut.length < 4 || intervals.some(i => !i.used || !Number.isFinite(i.r))) return null;
  let value = 1, peak = 1, drawdown = 0;
  const curve: [number, number][] = [[cut[0].ts, 1]];
  for (const i of intervals) {
    value *= Math.max(0, 1 + i.r);
    if (!Number.isFinite(value)) return null;
    peak = Math.max(peak, value); drawdown = Math.max(drawdown, 1 - value / peak);
    curve.push([i.end, value]);
  }
  return {periodReturn: value - 1, maxDrawdown: drawdown, curve,
    coveredDays: (cut.at(-1)!.ts - cut[0].ts) / DAY,
    startMs: cut[0].ts, endMs: cut.at(-1)!.ts, lastCapital: cut.at(-1)!.accountValue};
}
export function candidates(histories: History[], cutoffMs: number): Candidate[] {
  return histories.flatMap(h => {
    const s = windowStats(h.points, cutoffMs - 30 * DAY, cutoffMs);
    if (!s || s.coveredDays < 20 || cutoffMs - s.endMs > 8 * DAY || s.lastCapital < 10_000 || s.periodReturn <= 0) return [];
    return [{address: h.address, trainReturn: s.periodReturn, trainDrawdown: s.maxDrawdown, capitalUsd: s.lastCapital}];
  });
}
export function allocate(rows: Candidate[], algorithm: Algorithm, cutoffMs: number): Allocation {
  const ranked = [...rows].sort((a, b) =>
    (algorithm === 'return-first.v1' ? b.trainReturn - a.trainReturn : a.trainDrawdown - b.trainDrawdown) ||
    b.trainReturn - a.trainReturn || a.address.localeCompare(b.address));
  const chosen = ranked.slice(0, 5);
  // Fewer than five leaves an explicit cash-only allocation, without inventing rows.
  return allocationSchema.parse({schemaVersion: 'night-allocation.v1', algorithm, cutoffMs, eligible: rows.length,
    sources: chosen.length === 5 ? chosen.map(r => ({...r, weight: 0.16})) : [],
    cashWeight: chosen.length === 5 ? 0.2 : 1});
}
export function evaluate(allocation: Allocation, histories: History[], through: number) {
  const from = allocation.cutoffMs, byAddress = new Map(histories.map(h => [h.address, h]));
  const observed = allocation.sources.map(s => ({source: s,
    stats: windowStats(byAddress.get(s.address)?.points ?? [], from, through)}));
  // Selection is never changed based on later availability or performance.
  const missing = observed.filter(r => !r.stats || r.stats.coveredDays < (through - from) / DAY * 0.7 || through - r.stats.endMs > 8 * DAY).map(r => r.source.address);
  if (!allocation.sources.length || missing.length) return {status: 'INCOMPLETE' as const, missing, curve: [] as [number, number][], periodReturn: null, maxDrawdown: null};
  const times = [...new Set([from, through, ...observed.flatMap(r => r.stats!.curve.map(p => p[0]))])].sort((a, b) => a - b);
  // Fixed source sleeves, no daily rebalancing. 10 bps assumption on entry and exit.
  const invested = 1 - allocation.cashWeight, cost = invested * 0.001;
  let peak = 1, dd = 0;
  const curve: [number, number][] = times.map(t => {
    let v = allocation.cashWeight;
    for (const {source, stats} of observed) {
      let mark = 1; for (const p of stats!.curve) {if (p[0] > t) break; mark = p[1];}
      v += source.weight * mark;
    }
    if (t > from) v -= cost; if (t === through) v -= cost;
    peak = Math.max(peak, v); dd = Math.max(dd, 1 - v / peak);
    return [t, v];
  });
  return {status: 'COMPLETE' as const, missing, curve, periodReturn: curve.at(-1)![1] - 1, maxDrawdown: dd,
    observationSpans: observed.map(r => ({address: r.source.address, startMs: r.stats!.startMs, endMs: r.stats!.endMs, coveredDays: r.stats!.coveredDays}))};
}

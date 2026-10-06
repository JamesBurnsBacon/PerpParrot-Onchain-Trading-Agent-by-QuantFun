import { type Analysis, curveAt } from "./metrics";
import { DAY_MS } from "./stitch";
import type { ScoreInput } from "./types";

// Connected components include unranked inputs; unknown addresses add no edge (SPEC "Clone grouping").
export const linkGroups = (inputs: ScoreInput[]): Map<string, string> => {
  const edges = new Map(inputs.map(({ address }) => [address.toLowerCase(), new Set<string>()]));
  for (const input of inputs) {
    const from = input.address.toLowerCase();
    for (const address of input.links ?? []) {
      const to = address.toLowerCase();
      if (!edges.has(to)) continue;
      edges.get(from)!.add(to);
      edges.get(to)!.add(from);
    }
  }
  const groups = new Map<string, string>();
  for (const address of edges.keys()) {
    if (groups.has(address)) continue;
    groups.set(address, address);
    const pending = [address];
    while (pending.length > 0) {
      for (const neighbor of edges.get(pending.pop()!)!) {
        if (groups.has(neighbor)) continue;
        groups.set(neighbor, address);
        pending.push(neighbor);
      }
    }
  }
  return groups;
};

// Log returns between consecutive UTC midnights of the fine span, keyed by the later midnight
// (SPEC "Clone grouping").
export const dailyReturns = ({ curve, fineStart, lastTs }: Analysis): Map<number, number> => {
  const returns = new Map<number, number>();
  let previous: number | null = null;
  for (let midnight = Math.ceil(fineStart / DAY_MS) * DAY_MS; midnight <= lastTs; midnight += DAY_MS) {
    const value = curveAt(curve, midnight);
    if (previous !== null && previous > 0 && value > 0) returns.set(midnight, Math.log(value / previous));
    previous = value;
  }
  return returns;
};

// Pearson correlation over the days both have; null below the overlap minimum or with no variance.
export const correlation = (a: Map<number, number>, b: Map<number, number>, minOverlapDays: number): number | null => {
  const days = [...a.keys()].filter((day) => b.has(day)).sort((x, y) => x - y);
  if (days.length < minOverlapDays) return null;
  const xs = days.map((day) => a.get(day)!);
  const ys = days.map((day) => b.get(day)!);
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
  if (sxx === 0 || syy === 0) return null;
  const rho = sxy / Math.sqrt(sxx * syy);
  return Number.isFinite(rho) ? rho : null;
};

// Known same-operator links (vault <-> leader, sub-accounts), in either direction.
export const linked = (a: ScoreInput, b: ScoreInput): boolean => {
  const has = (from: ScoreInput, to: ScoreInput) =>
    (from.links ?? []).some((address) => address.toLowerCase() === to.address.toLowerCase());
  return has(a, b) || has(b, a);
};

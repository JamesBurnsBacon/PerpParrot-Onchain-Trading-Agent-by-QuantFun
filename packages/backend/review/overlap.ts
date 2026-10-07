// Same-direction exposure overlap between two accounts' current books, in [0, 1]: the scale of the
// policy's `maxExposureOverlap` and the frame's `currentExposureOverlap`.
//
// Each book becomes a net signed notional per market (summed over dexes), divided by its gross
// notional, so only the composition counts, not the size or leverage. overlap(a, b) is the sum, over
// markets both hold in the same direction, of the smaller share. Identical books give 1; opposite or
// disjoint books give 0. An account with no positions overlaps with nobody (0).
import type { LivePosition } from "./input.ts";

type Book = ReadonlyMap<string, number>;

const shares = (positions: readonly LivePosition[]): Book => {
  const net = new Map<string, number>();
  for (const p of positions) net.set(p.market, (net.get(p.market) ?? 0) + p.signedNotionalUsd);
  const gross = [...net.values()].reduce((sum, v) => sum + Math.abs(v), 0);
  return new Map(gross > 0 ? [...net].map(([market, v]) => [market, v / gross] as const) : []);
};

const overlapOf = (a: Book, b: Book): number => {
  let sum = 0;
  for (const [market, x] of a) {
    const y = b.get(market) ?? 0;
    if (x * y > 0) sum += Math.min(Math.abs(x), Math.abs(y));
  }
  return Math.min(1, sum);
};

export const exposureOverlap = (a: readonly LivePosition[], b: readonly LivePosition[]): number => overlapOf(shares(a), shares(b));

export type OverlapSummary = {
  threshold: number;
  pairs: number;
  above: number; // pairs over the threshold
  max: number;
  top: { a: string; b: string; overlap: number }[]; // the largest pairs, descending
  byAddress: Record<string, number>; // each account's largest overlap with any other
};

const round = (v: number) => Math.round(v * 1e4) / 1e4;

// Every pair among `addresses` (positions keyed by lower-case address; a missing book counts as empty).
export const summarizeOverlap = (addresses: readonly string[], positions: ReadonlyMap<string, readonly LivePosition[]>, threshold: number, topN = 5): OverlapSummary => {
  const keys = addresses.map((a) => a.toLowerCase());
  const books = keys.map((a) => shares(positions.get(a) ?? []));
  const all: { a: string; b: string; overlap: number }[] = [];
  const byAddress: Record<string, number> = Object.fromEntries(keys.map((a) => [a, 0]));
  for (let i = 0; i < keys.length; i++) {
    for (let j = i + 1; j < keys.length; j++) {
      const overlap = round(overlapOf(books[i]!, books[j]!));
      all.push({ a: keys[i]!, b: keys[j]!, overlap });
      byAddress[keys[i]!] = Math.max(byAddress[keys[i]!]!, overlap);
      byAddress[keys[j]!] = Math.max(byAddress[keys[j]!]!, overlap);
    }
  }
  all.sort((x, y) => y.overlap - x.overlap || (x.a < y.a ? -1 : x.a > y.a ? 1 : x.b < y.b ? -1 : 1));
  return { threshold, pairs: all.length, above: all.filter((p) => p.overlap > threshold).length, max: all[0]?.overlap ?? 0, top: all.slice(0, topN), byAddress };
};

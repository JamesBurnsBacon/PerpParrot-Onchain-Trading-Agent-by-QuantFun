import { scoreCandidates, type ScoreInput, type TimePoint } from "../src/score";
import type { FinalistLike } from "../../shared/strategy-intent";

export type SampleFinalist = FinalistLike & { dataSource: "sample"; rank: number | null; cloneAddress: string | null; profile: string };
// Fixed synthetic paths, never accounts fetched from a venue. Score is used unchanged.
export const makeSampleFinalists = (): SampleFinalist[] => {
  let seed = 20261006;
  const random = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 2 ** 32);
  const cloneSources = [2, 5, 14, 8, 17, 22, 0, 6];
  const inputs: ScoreInput[] = [];
  for (let i = 0; i < 36; i++) {
    const clone = i >= 28;
    const group = i % 3;
    let equity = 100000;
    const av: TimePoint[] = [], pnl: TimePoint[] = [];
    for (let day = 0; day <= 90; day++) {
      const ts = Date.UTC(2026, 5, 1) + day * 86400000;
      if (day) {
        const amplitude = [0.065, 0.018, 0.006][group];
        const drift = [0.012, 0.0026, 0.00065][group];
        equity *= 1 + drift + (random() - 0.5) * amplitude * 2;
      }
      av.push([ts, equity]); pnl.push([ts, equity - 100000]);
    }
    const history = clone ? inputs[cloneSources[i - 28]].allTime! : { accountValueHistory: av, pnlHistory: pnl };
    inputs.push({ address: `addr-${String(i + 1).padStart(2, "0")}`, kind: "trader", accountValue: history.accountValueHistory.at(-1)![1],
      closed: false, tradeCount: 500, history: null, month: history, allTime: history });
  }
  const scored = scoreCandidates(inputs);
  const rows: SampleFinalist[] = scored.candidates.map(c => ({ address: c.address, kind: c.kind, score: c.score,
    flags: c.metrics!.flags, maxDrawdown: c.metrics!.maxDrawdown, annualisedVol: c.metrics!.annualisedVol,
    cloneOf: c.cloneOf !== null, cloneAddress: c.cloneOf?.address ?? null, rank: c.rank, dataSource: "sample",
    profile: ["synthetic degen", "synthetic swing", "synthetic grinder"][(Number(c.address.slice(-2)) > 28 ? cloneSources[Number(c.address.slice(-2)) - 29] : Number(c.address.slice(-2)) - 1) % 3] }));
  // Deliberate exclusion controls, not fabricated ranked Score results.
  for (const [i, flag] of ["overflow", "ruin", "low-coverage", "no-intervals"].entries()) rows.push({
    address: `addr-${37 + i}`, kind: "trader", score: null, flags: [flag], maxDrawdown: null, annualisedVol: null,
    cloneOf: false, cloneAddress: null, rank: null, dataSource: "sample", profile: `synthetic ${flag} control`,
  });
  return rows;
};
if (import.meta.main) await Bun.write(new URL("../fixtures/sample-finalists.json", import.meta.url), `${JSON.stringify(makeSampleFinalists(), null, 2)}\n`);

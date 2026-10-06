import type { Kind, Ratio, ScoreResult } from "./types";

// The review's kind enum (packages/shared contracts).
const FRAME_KIND: Record<Kind, "TRADER" | "HYPERCORE_VAULT" | "ERC4626_HYPERCORE"> = {
  "trader": "TRADER",
  "hypercore-vault": "HYPERCORE_VAULT",
  "erc4626-vault": "ERC4626_HYPERCORE",
};

// Score-owned fields of a candidate-curation-frame 1.1.0 candidate. Fill-derived fields stay null when ingest has
// not supplied them; other modules fill the rest of the frame (SPEC "Frame adapter").
export type FrameCandidate = {
  candidate: number;
  kind: "TRADER" | "HYPERCORE_VAULT" | "ERC4626_HYPERCORE";
  clones: string[];
  metrics: {
    historyDays: number;
    maxDrawdown: number;
    pnlConsistency: number;
    averageLeverage: number | null;
    timeInMarket: number | null;
    makerShare: number | null;
    medianHoldMinutes: number | null;
    isSharpe: number | null;
    isSortino: number | null;
    isCalmar: number | null;
    lookbackDays: number;
    scoreFlags: string[];
    // In-sample Score metrics never fill the out-of-sample fields; the backtest does.
    oosWindows: 0;
    oosSharpe: null;
    oosSortino: null;
    oosMaxDrawdown: null;
    crossWindowStability: null;
  };
};

export type FramePair = { a: number; b: number; correlation: number | null; linkedSource: boolean };

const finiteRatio = (value: Ratio): number | null => value === "+inf" ? null : value;

// Map Score finalists to frame candidates and pairs, indexed by finalist position (SPEC "Frame adapter").
export const toFrameCandidates = (result: ScoreResult): { candidates: FrameCandidate[]; pairs: FramePair[] } => {
  const position = new Map(result.finalists.map((address, i) => [address, i]));
  const candidates = result.finalists.map((address, i): FrameCandidate => {
    const candidate = result.candidates.find((c) => c.address === address);
    if (candidate === undefined || candidate.metrics === null || candidate.metrics.maxDrawdown === null) {
      throw new Error(`frame: finalist without metrics: ${address}`);
    }
    const { metrics, passthrough } = candidate;
    return {
      candidate: i,
      kind: FRAME_KIND[candidate.kind],
      clones: candidate.clones,
      metrics: {
        historyDays: candidate.activeDays ?? 0,
        maxDrawdown: metrics.maxDrawdown!,
        pnlConsistency: metrics.consistency ?? 0,
        averageLeverage: passthrough.avgLeverage,
        timeInMarket: passthrough.timeInMarket,
        makerShare: passthrough.makerShare,
        medianHoldMinutes: passthrough.medianHoldHours === null ? null : passthrough.medianHoldHours * 60,
        isSharpe: finiteRatio(metrics.sharpe),
        isSortino: finiteRatio(metrics.sortino),
        isCalmar: finiteRatio(metrics.calmar),
        lookbackDays: metrics.lookbackDays,
        scoreFlags: metrics.flags,
        oosWindows: 0,
        oosSharpe: null,
        oosSortino: null,
        oosMaxDrawdown: null,
        crossWindowStability: null,
      },
    };
  });
  const pairs = result.correlations.map(({ a, b, rho, linked }): FramePair => ({
    a: position.get(a)!,
    b: position.get(b)!,
    correlation: rho,
    linkedSource: linked,
  }));
  return { candidates, pairs };
};

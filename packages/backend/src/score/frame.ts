import type { Kind, Ratio, ScoreResult } from "./types";

// The review's kind enum (packages/shared contracts).
const FRAME_KIND: Record<Kind, "TRADER" | "HYPERCORE_VAULT" | "ERC4626_HYPERCORE"> = {
  "trader": "TRADER",
  "hypercore-vault": "HYPERCORE_VAULT",
  "erc4626-vault": "ERC4626_HYPERCORE",
};

// Score-owned fields of a candidate-curation-frame 1.1.0 candidate. `clones` (addresses) is the audit trail;
// models only see `metrics.cloneCount`. Fill-derived fields stay null when ingest has
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
    cloneCount: number;
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

// Map finalists with known history to kept positions and report omissions (SPEC "Frame adapter").
// `addresses[i]` is candidate i's address: the frame's source mapping, never model input.
export const toFrameCandidates = (result: ScoreResult): {
  candidates: FrameCandidate[];
  addresses: string[];
  pairs: FramePair[];
  skipped: { address: string; reason: "unknown-history" }[];
} => {
  const position = new Map<string, number>();
  const candidates: FrameCandidate[] = [];
  const skipped: { address: string; reason: "unknown-history" }[] = [];
  for (const address of result.finalists) {
    const candidate = result.candidates.find((c) => c.address === address);
    if (candidate === undefined || candidate.metrics === null || candidate.metrics.maxDrawdown === null) {
      throw new Error(`frame: finalist without metrics: ${address}`);
    }
    if (candidate.activeDays === null) {
      skipped.push({ address, reason: "unknown-history" });
      continue;
    }
    const { metrics, passthrough } = candidate;
    position.set(address, candidates.length);
    candidates.push({
      candidate: candidates.length,
      kind: FRAME_KIND[candidate.kind],
      clones: candidate.clones,
      metrics: {
        historyDays: Math.floor(candidate.activeDays),
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
        cloneCount: candidate.clones.length,
        oosWindows: 0,
        oosSharpe: null,
        oosSortino: null,
        oosMaxDrawdown: null,
        crossWindowStability: null,
      },
    });
  }
  const pairs = result.correlations.filter(({ a, b }) => position.has(a) && position.has(b))
    .map(({ a, b, rho, linked }): FramePair => ({
      a: position.get(a)!,
      b: position.get(b)!,
      correlation: rho,
      linkedSource: linked,
    }));
  return { candidates, addresses: [...position.keys()], pairs, skipped };
};

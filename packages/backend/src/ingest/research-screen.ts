// Frozen v1 arithmetic for offline replay of the first-pass dataset.
// The Top 100 worker uses strict Score and does not call this research screen.
import { DEFAULT_CONFIG, computeMetrics, parsePortfolio } from "../score";
import { buildSeries, DAY_MS, validateSeries } from "../score/stitch";
import { computeIntervals } from "../score/returns";
import type { ScoreInput } from "../score/types";
type Evidence = { address: string; raw: string; sha256: string; fetchedAt: string };
import type { Candidate } from "./types";
import { digest } from "./store";

// Research triage, not Score eligibility. These provisional thresholds are
// explicit so an empirical choice cannot be confused with a trading signal.
export const SCREEN_POLICY = Object.freeze({
  version: "research-screen.v1", minCapitalUsd: 10000, lookbackDays: 90,
  minStageDays: 30, recentReturn: 0.05, fullReturn: 0.10, bestStageReturn: 0.15,
  lossBlockReturn: -0.01, totalLossReturn: -0.05, riskReviewDrawdown: 0.60,
  maxGapDays: 10, staleHours: 24, inactivePnlRangeUsd: 1,
});
export type Decision = "candidate" | "candidate-review" | "watch" | "cold" | "skip" | "review";
export type Period = {
  start: string; end: string; days: number; return: number; pnlUsd: number;
  maxDrawdown: number; drawdownPeak: string | null; drawdownTrough: string | null;
  maxGapDays: number;
};
export type ScreenRow = {
  address: string; name: string | null; classification: string; decision: Decision;
  reasons: string[]; flags: string[]; evaluatedAt: string;
  fetchedAt: string | null; evidenceSha256: string | null;
  seedCapitalUsd: number; capitalSource: string; portfolioEquityUsd: number | null;
  capitalAt: string | null; monthVolumeUsd: number | null;
  observation: Period | null; recentMonth: Period | null; bestStage: Period | null;
  lossBlocks: Period[]; fineTimeShare: number | null; score: null; eligible: null;
};

export function screenEvidence(e: Evidence, c: Candidate, now = Date.now()): ScreenRow {
  const row: ScreenRow = { address: c.address, name: c.name,
    classification: c.knownHypercoreVault ? "known-hypercore-vault" : "unverified-account",
    decision: "review", reasons: [], flags: [], evaluatedAt: new Date(now).toISOString(),
    fetchedAt: null, evidenceSha256: null, seedCapitalUsd: Number(c.accountValueOrTvlUsd),
    capitalSource: c.valueSource, portfolioEquityUsd: null, capitalAt: null, monthVolumeUsd: null,
    observation: null, recentMonth: null, bestStage: null, lossBlocks: [], fineTimeShare: null,
    score: null, eligible: null };
  try {
    if (!e || e.address !== c.address || typeof e.raw !== "string" || digest(e.raw) !== e.sha256
      || !Number.isFinite(Date.parse(e.fetchedAt))) throw new Error("invalid-evidence");
    row.fetchedAt = e.fetchedAt; row.evidenceSha256 = e.sha256;
    const raw = JSON.parse(e.raw);
    const windows = parsePortfolio(raw);
    if (!validateSeries(windows.month) || !validateSeries(windows.allTime)) throw new Error("invalid-history");
    // kind here is only a required metrics input field, never a verified classification.
    const input: ScoreInput = { address: c.address, kind: "trader", accountValue: row.seedCapitalUsd,
      closed: null, history: null, tradeCount: null, ...windows };
    const series = buildSeries(input, DEFAULT_CONFIG);
    const metrics = computeMetrics(input);
    if (!series || series.points.length < 2 || !metrics) throw new Error("insufficient-history");
    const points = series.points;
    if (points.some(p => p.ts < 0 || p.accountValue < 0 || !Number.isFinite(p.accountValue) || !Number.isFinite(p.pnl))) {
      throw new Error("invalid-values");
    }
    const { intervals, flags } = computeIntervals(points, DEFAULT_CONFIG.dustEquityFraction);
    row.flags = [...new Set([...metrics.flags, ...series.flags, ...flags])];
    row.fineTimeShare = metrics.fineTimeShare;
    const last = points.at(-1)!;
    row.portfolioEquityUsd = last.accountValue; row.capitalAt = new Date(last.ts).toISOString();
    const volume = raw.find((x: unknown[]) => x[0] === "month")?.[1]?.vlm;
    row.monthVolumeUsd = typeof volume === "string" && /^\d+(\.\d+)?$/.test(volume)
      && Number.isFinite(Number(volume)) ? Number(volume) : null;
    if (row.monthVolumeUsd === null) row.flags.push("unknown-volume");
    const fetched = Date.parse(e.fetchedAt);
    if (fetched > now + 300000 || last.ts > fetched + 300000 || fetched - last.ts > DAY_MS
      || now - fetched > SCREEN_POLICY.staleHours * 3600000) row.flags.push("stale-or-future-data");
    if (intervals.some(i => !i.used || !Number.isFinite(i.r) || i.r <= -1)) row.flags.push("unreliable-return-path");
    const nav = [1];
    for (const i of intervals) nav.push(nav.at(-1)! * (1 + i.r));
    if (nav.some(v => !Number.isFinite(v) || v <= 0)) throw new Error("invalid-return-path");

    const period = (a: number, b: number): Period => {
      let peak = nav[a], peakAt = a, drawdown = 0, peakIndex: number | null = null, troughIndex: number | null = null;
      let maxGapDays = 0;
      for (let k = a + 1; k <= b; k++) {
        if (nav[k] > peak) { peak = nav[k]; peakAt = k; }
        const d = 1 - nav[k] / peak;
        if (d > drawdown) { drawdown = d; peakIndex = peakAt; troughIndex = k; }
        maxGapDays = Math.max(maxGapDays, intervals[k - 1].dt);
      }
      return { start: new Date(points[a].ts).toISOString(), end: new Date(points[b].ts).toISOString(),
        days: (points[b].ts - points[a].ts) / DAY_MS, return: nav[b] / nav[a] - 1,
        pnlUsd: points[b].pnl - points[a].pnl, maxDrawdown: drawdown,
        drawdownPeak: peakIndex === null ? null : new Date(points[peakIndex].ts).toISOString(),
        drawdownTrough: troughIndex === null ? null : new Date(points[troughIndex].ts).toISOString(), maxGapDays };
    };
    const end = points.length - 1;
    const closest = (target: number) => points.reduce((best, p, k) =>
      Math.abs(p.ts - target) < Math.abs(points[best].ts - target) ? k : best, 0);
    row.observation = period(0, end);
    const m = period(closest(last.ts - 30 * DAY_MS), end);
    if (m.days >= 28 && m.days <= 38) row.recentMonth = m;
    // Search every observed start/end, but require >=30 days. No interpolation,
    // annualisation, or skipped bad days. Ties favour the longer period.
    let bestA = -1, bestB = -1, bestReturn = -Infinity, bestDays = 0;
    for (let a = 0; a < end; a++) for (let b = a + 1; b <= end; b++) {
      const days = (points[b].ts - points[a].ts) / DAY_MS;
      const r = nav[b] / nav[a] - 1;
      if (days >= SCREEN_POLICY.minStageDays && (r > bestReturn || (r === bestReturn && days > bestDays))) {
        bestA = a; bestB = b; bestReturn = r; bestDays = days;
      }
    }
    if (bestA >= 0) row.bestStage = period(bestA, bestB);
    if (row.observation.maxGapDays > SCREEN_POLICY.maxGapDays) row.flags.push("large-history-gap");
    if (intervals.some(i => i.dt > 2 && i.r >= 1)) row.flags.push("large-coarse-gain");
    const qualityBad = ["stitch-mismatch", "history-mismatch", "no-alltime", "stale-or-future-data",
      "unreliable-return-path", "large-history-gap", "overflow"].some(f => row.flags.includes(f));
    if (qualityBad || row.observation.days < 30) {
      row.reasons = [qualityBad ? "data-needs-review" : "history-under-30-days"]; return row;
    }
    if (row.seedCapitalUsd < SCREEN_POLICY.minCapitalUsd) {
      row.decision = "skip"; row.reasons = ["seed-capital-below-10000"]; return row;
    }
    // For vaults the seed TVL is the size measure. A portfolio endpoint is not
    // assumed to be the same economic entity as vault TVL.
    if (!c.knownHypercoreVault && row.portfolioEquityUsd < SCREEN_POLICY.minCapitalUsd) {
      row.reasons = ["current-capital-below-10000-confirm-kind"]; return row;
    }
    if (row.observation.days >= 80) {
      const edges = [0, closest(last.ts - 60 * DAY_MS), closest(last.ts - 30 * DAY_MS), end];
      if (edges.every((v, i) => i === 0 || v > edges[i - 1])) {
        row.lossBlocks = edges.slice(1).map((b, i) => period(edges[i], b));
      }
      const recent = period(closest(last.ts - 7 * DAY_MS), end);
      if (row.lossBlocks.length === 3 && row.lossBlocks.every(p => p.days >= 21 && p.days <= 40
        && p.return <= SCREEN_POLICY.lossBlockReturn && p.pnlUsd < -1)
        && row.observation.return <= SCREEN_POLICY.totalLossReturn
        && recent.days >= 5 && recent.days <= 10 && recent.return <= 0) {
        row.decision = "skip"; row.reasons = ["three-losing-blocks-no-recent-recovery"]; return row;
      }
    }
    const month = windows.month!;
    const monthlyPnl = month.pnlHistory.map(p => p[1]);
    const monthDays = (month.pnlHistory.at(-1)![0] - month.pnlHistory[0][0]) / DAY_MS;
    const monthlyMaxGap = Math.max(...month.pnlHistory.slice(1).map((p, k) => (p[0] - month.pnlHistory[k][0]) / DAY_MS));
    if (monthDays >= 28 && monthlyPnl.length >= 25 && monthlyMaxGap <= 2 && row.monthVolumeUsd === 0
      && Math.max(...monthlyPnl) - Math.min(...monthlyPnl) <= SCREEN_POLICY.inactivePnlRangeUsd) {
      row.decision = "cold"; row.reasons = ["possible-inactivity-confirm-positions-and-fills"]; return row;
    }
    if (row.recentMonth && row.recentMonth.return >= SCREEN_POLICY.recentReturn) row.reasons.push("recent-month-return-at-least-5pct");
    if (row.observation.days >= 80 && row.observation.return >= SCREEN_POLICY.fullReturn) row.reasons.push("full-window-return-at-least-10pct");
    if (row.bestStage && row.bestStage.return >= SCREEN_POLICY.bestStageReturn) row.reasons.push("historical-stage-return-at-least-15pct");
    if (row.observation.maxDrawdown >= SCREEN_POLICY.riskReviewDrawdown) row.flags.push("large-drawdown");
    if (row.reasons.length) row.decision = row.flags.some(f => ["large-drawdown", "large-coarse-gain", "unknown-volume"].includes(f))
      ? "candidate-review" : "candidate";
    else { row.decision = "watch"; row.reasons = ["no-positive-trigger-yet"]; }
    return row;
  } catch (error) {
    // Retain a visible review row; a broken response is not a losing account.
    row.decision = "review";
    row.reasons = [error instanceof Error && /^[a-z-]+$/.test(error.message) ? error.message : "invalid-evidence-or-history"];
    return row;
  }
}

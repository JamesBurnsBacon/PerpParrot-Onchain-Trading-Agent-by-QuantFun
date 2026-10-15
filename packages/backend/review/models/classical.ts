// The classical committee: a deterministic stand-in for the OpenAI committee (openai-paper.ts) when it
// can't answer (owner, 2026-10-15: no new AI key). It reads the same anonymous evidence and returns
// the same Role, Risk and Red-Team rows on the same 0–100 scales, following docs/agents/SYSTEM_PROMPTS.md:
// risk-adjusted, repeatable performance makes a fit; drawdown, leverage, liquidation distance,
// concentration, path and copyability are risks assessed separately (no offsetting); null is unknown,
// never safe. Policy code downstream decides exactly as it does for the models' rows.
import {commitment} from '../../../shared/src/commitments.ts';
import type {CommitteeEvidence} from '../../../shared/src/committee-evidence.ts';
import type {Row} from '../../../shared/src/contracts.ts';
import type {CommitteeDependencies,EvidenceObservation,EvidenceCritique} from '../committee/types.ts';
import type {PaperModelCore} from './types.ts';

export const CLASSICAL_VERSION = 'classical-v1';
const nodeId = 'classical';

type Metrics = CommitteeEvidence['finalists'][number]['metrics'];

const clamp = (x: number, lo = 0, hi = 1) => Math.min(hi, Math.max(lo, x));
const score = (x: number) => Math.round(100 * clamp(x));

// The worse of the out-of-sample and Score's lookback drawdown (fractions of equity).
const drawdown = (m: Metrics) => Math.max(m.oosMaxDrawdown ?? 0, m.maxDrawdown ?? 0);
// Latency at the 10-minute copy cadence, as the strict compiler discounts holds (workflow.ts compile).
const holdFactor = (minutes: number | null) => (minutes === null ? 0.75 : minutes < 60 ? 0.5 : minutes < 180 ? 0.75 : minutes < 360 ? 0.9 : 1);
// Missing measurements, which lower confidence and raise evidence risk.
const unknowns = (m: Metrics) =>
  [m.oosSharpe, m.oosSortino, m.oosMaxDrawdown, m.crossWindowStability, m.medianHoldMinutes, m.averageLeverage, m.executionFit, m.liquidationDistance].filter((v) => v === null).length;

export function classicalRisk(m: Metrics): Omit<Row, 'candidate'> {
  // 0 at no drawdown, 100 at 60%: a reject (> 80) above a 48% drawdown.
  const drawdownRisk = score(drawdown(m) / 0.6);
  // Average leverage: 100 at 10×. Liquidation distance (fraction of price): 0 at ≥ 30%, 100 at ≤ 3%.
  const leverage = m.averageLeverage === null ? 0 : m.averageLeverage / 10;
  const liquidation = m.liquidationDistance === null ? 0 : (0.3 - m.liquidationDistance) / 0.27;
  const leverageRisk = score(Math.max(leverage, liquidation));
  // One-perp books are common and not alone a reason to exclude: at most 70.
  const concentrationRisk = Math.round(70 * clamp(m.concentration ?? 0.5));
  // Path: an unstable OOS record (windows disagree) and a noisy curve. At most 75; losing
  // out of sample is a Role reject, not a path score.
  const pathRisk = Math.round(75 * clamp(0.6 * (1 - (m.crossWindowStability ?? 0.3)) + 0.4 * (1 - clamp(m.pnlConsistency))));
  // Copyability: the measured execution fit; unknown is a material concern, not a reject.
  const executionRisk = m.executionFit === null ? 70 : score(1 - m.executionFit / 100);
  const evidenceRisk = score(0.2 + 0.1 * unknowns(m) + (m.oosWindows < 2 ? 0.2 : 0));
  return {drawdownRisk, leverageRisk, concentrationRisk, pathRisk, executionRisk, evidenceRisk, confidence: confidence(m)};
}

function confidence(m: Metrics): number {
  return score(0.3 + 0.15 * Math.min(m.oosWindows, 2) + 0.2 * clamp(m.historyDays / 90) - 0.05 * unknowns(m));
}

export function classicalRole(m: Metrics, meanCorrelation: number | null, minHistoryDays: number): Omit<Row, 'candidate'> {
  const sharpe = m.oosSharpe ?? m.isSharpe;
  const sortino = m.oosSortino ?? m.isSortino;
  const stability = m.crossWindowStability ?? 0.3;
  const dd = clamp(drawdown(m) / 0.5);
  const leverage = clamp((m.averageLeverage ?? 0) / 10);
  // Repeatable risk-adjusted performance (owner: fit = risk-adjusted & stable), penalized for drawdown
  // and short holds at the copy cadence.
  const quality = 0.45 * clamp(sharpe ?? 0, -1, 1) + 0.25 * clamp((sortino ?? 0) / 5, -1, 1) + 0.3 * stability;
  const base = clamp(quality) * holdFactor(m.medianHoldMinutes);
  const aggressiveFit = score(base * (1 - 0.5 * dd));
  const balancedFit = score(base * (1 - dd) * (1 - 0.5 * leverage));
  const conservativeFit = score(base * (1 - dd) ** 2 * (1 - leverage));
  // Losing out of sample (or too short a record) supports exclusion.
  const losing = m.oosWindows > 0 && sharpe !== null && sharpe < 0 && (sortino === null || sortino < 0);
  const reject = losing ? 90 : m.historyDays < minHistoryDays / 2 ? 85 : Math.round(40 * dd);
  const timeInMarket = clamp(m.timeInMarket ?? 0.5);
  return {
    preserver: score((1 - dd) * (1 - leverage) * stability),
    compounder: score(clamp(sharpe ?? 0) * stability),
    diversifier: meanCorrelation === null ? 50 : score(1 - meanCorrelation),
    directional: score(timeInMarket * clamp(sharpe ?? 0)),
    opportunistic: score((1 - timeInMarket) * clamp(sharpe ?? 0)),
    convexity: 0, // not substantiated by any supplied metric: never invented
    reject,
    conservativeFit,
    balancedFit,
    aggressiveFit,
    confidence: confidence(m),
  };
}

const meanAbsCorrelation = (evidence: CommitteeEvidence, candidate: number): number | null => {
  const known = evidence.pairs.filter((p) => (p.a === candidate || p.b === candidate) && p.correlation !== null).map((p) => Math.abs(p.correlation!));
  return known.length ? known.reduce((s, x) => s + x, 0) / known.length : null;
};

/** Same interface as the OpenAI committee (quorum 1, one node), so the review core, audit and gates
 * treat its rows exactly as the models'. */
export function classicalCommittee(core: PaperModelCore, minHistoryDays: number): CommitteeDependencies {
  const hash = (stage: string) => commitment('perpparrot:prompt:v1', `${CLASSICAL_VERSION}:${stage}`);
  const promptHashes = {role: hash('role'), risk: hash('risk'), redteam: hash('redteam')};
  const modelConfigHash = commitment('perpparrot:model:v1', {provider: 'classical', model: CLASSICAL_VERSION, temperature: 0, promptHashes});
  const binding = (evidence: CommitteeEvidence, promptHash: string) => ({
    schemaVersion: evidence.schemaVersion, snapshotHash: evidence.snapshotHash, policyHash: evidence.policyHash, promptHash, modelConfigHash, nodeId, evidenceHash: evidence.evidenceHash,
  });
  const rows = (evidence: CommitteeEvidence, f: (finalist: CommitteeEvidence['finalists'][number]) => Omit<Row, 'candidate'>): Row[] =>
    [...evidence.finalists].sort((a, b) => a.candidate - b.candidate).map((finalist) => ({candidate: finalist.candidate, ...f(finalist)}) as Row);
  return {
    ...core, nodeIds: [nodeId], quorum: 1, rolePromptHash: promptHashes.role, riskPromptHash: promptHashes.risk, redTeamPromptHash: promptHashes.redteam, modelConfigHash,
    role: async (evidence) => [{...binding(evidence, promptHashes.role), results: rows(evidence, (f) => classicalRole(f.metrics, meanAbsCorrelation(evidence, f.candidate), minHistoryDays))} as EvidenceObservation],
    risk: async (evidence) => [{...binding(evidence, promptHashes.risk), results: rows(evidence, (f) => classicalRisk(f.metrics))} as EvidenceObservation],
    // Pair correlation and exposure overlap are already enforced by the compiler; the classical red
    // team adds no penalties of its own.
    redTeam: async (input) => [{
      ...binding(input.evidence, promptHashes.redteam), draftHash: input.draftHash, rebuildScore: 0, portfolioRisk: 0,
      penalties: [...input.sources].sort((a, b) => a.candidate - b.candidate).map((s) => ({candidate: s.candidate, multiplier: 1, excludeScore: 0})),
    } as EvidenceCritique],
  };
}

import type { Policy } from "../../../shared/src/contracts";
import { intentToPolicy, shortlist, type FinalistLike, type StrategyIntent } from "../../../shared/parrot-intent";
import type { WalletEvidence, WalletChanges } from "../../../shared/wallet-evidence";
type Data = { finalists: FinalistLike[]; dataSource: "live" | "sample" };
const excluded = ["overflow", "ruin", "low-coverage", "no-intervals"];
// A wider conservative score window lets calm candidates enter when switching from a larger score-led list.
// This changes shortlist priority only, never Score or policy.
const windowLimit = (intent: StrategyIntent, cap: number) => intent.riskStyle === "conservative" ? Math.min(25, Math.ceil(cap * 1.2)) : cap;
export const selectStrategy = (intent: StrategyIntent, basePolicy: Policy, data: Data) => {
  const policyResult = intentToPolicy(intent, basePolicy);
  const { policy, ...summary } = policyResult;
  const addresses = shortlist(data.finalists, intent, windowLimit(intent, summary.effectiveMaxSources)).slice(0, summary.effectiveMaxSources);
  return { policyResult, policy: summary, shortlist: { addresses, dataSource: data.dataSource } };
};
const rounded = (n: number | null) => n === null ? null : Math.round(n * 10000) / 10000;
export const explainSelection = (intent: StrategyIntent, basePolicy: Policy, data: Data, previous?: string[]): { evidence: WalletEvidence[]; changes?: WalletChanges } => {
  const selection = selectStrategy(intent, basePolicy, data);
  const addresses = selection.shortlist.addresses;
  const scoreOrder = [...data.finalists].filter(f => f.score !== null && Number.isFinite(f.score)).sort((a, b) => b.score! - a.score! || (a.address < b.address ? -1 : 1));
  const eligible = scoreOrder.filter(f => !f.flags.some(flag => excluded.includes(flag)) && !(intent.avoidClones && f.cloneOf));
  const tags = (f: FinalistLike): string[] => [
    ...(f.maxDrawdown !== null && f.maxDrawdown <= .08 ? ["low drawdown"] : f.maxDrawdown !== null && f.maxDrawdown >= .2 ? ["high drawdown"] : []),
    ...(f.annualisedVol !== null && f.annualisedVol <= .2 ? ["low vol"] : f.annualisedVol !== null && f.annualisedVol >= .6 ? ["high vol"] : []),
    ...(intent.avoidClones ? ["clone-checked"] : []), "score selected",
  ];
  const evidence = addresses.map(address => {
    const f = data.finalists.find(f => f.address === address)!;
    const originalRank = (f as FinalistLike & { rank?: number }).rank;
    return { address, rank: originalRank ?? scoreOrder.findIndex(f => f.address === address) + 1,
      maxDrawdown: rounded(f.maxDrawdown), annualisedVol: rounded(f.annualisedVol), tags: tags(f) };
  });
  const reason = (address: string) => {
    const f = data.finalists.find(f => f.address === address)!;
    const flag = excluded.find(flag => f.flags.includes(flag));
    if (flag) return `flagged: ${flag}`;
    if (f.score === null) return "unranked";
    if (intent.avoidClones && f.cloneOf) {
      const clone = (f as FinalistLike & { cloneAddress?: string }).cloneAddress;
      return clone && /^[\w.:-]{1,66}$/.test(clone) ? `clone of ${clone}` : "clone excluded";
    }
    if (intent.riskStyle === "aggressive") return "ranked below the new source limit";
    if (eligible.findIndex(f => f.address === address) >= 2 * windowLimit(intent, selection.policy.effectiveMaxSources)) return "outside the style score window";
    return "lower priority for this style";
  };
  return { evidence, ...(previous === undefined ? {} : { changes: {
    added: addresses.filter(id => !previous.includes(id)).map(address => ({ address, reason: evidence.find(e => e.address === address)!.tags[0] })),
    removed: previous.filter(id => !addresses.includes(id)).map(address => ({ address, reason: reason(address) })),
  } }) };
};

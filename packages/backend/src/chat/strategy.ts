import type { Policy } from "../../../shared/src/contracts";
import { intentToPreview, shortlist, type FinalistLike, type StrategyIntent } from "../../../shared/strategy-intent";
import type { WalletEvidence, WalletChanges } from "../../../shared/wallet-evidence";
import { VIBE_THRESHOLDS } from "../../../shared/wallet-persona";
type Data = { finalists: FinalistLike[]; dataSource: "live" | "sample" };
const excluded = ["overflow", "ruin", "low-coverage", "no-intervals"];
// A wider conservative score window lets calm candidates enter when switching from a larger score-led list.
// This changes shortlist priority only, never Score or policy.
const windowLimit = (intent: StrategyIntent, cap: number) => intent.riskStyle === "conservative" ? Math.min(25, Math.ceil(cap * 1.2)) : cap;
// main's intentToPreview throws when the risk limits need more sources than the visitor allowed ("safe, a few wallets" asks for 5
// but the conservative limits need 6). Raise the limit to the smallest feasible number instead of failing the conversation.
const compile = (intent: StrategyIntent, basePolicy: Policy) => {
  try { return { policyResult: intentToPreview(intent, basePolicy), intent, raisedFrom: null as number | null }; }
  catch (error) {
    if (!(error instanceof RangeError) || !error.message.startsWith("infeasible")) throw error;
    for (let n = intent.maxSources + 1; n <= 25; n++) {
      const raised = { ...intent, maxSources: n };
      try { return { policyResult: intentToPreview(raised, basePolicy), intent: raised, raisedFrom: intent.maxSources as number | null }; }
      catch (retry) { if (!(retry instanceof RangeError)) throw retry; }
    }
    throw error;
  }
};
export const selectStrategy = (requested: StrategyIntent, basePolicy: Policy, data: Data) => {
  const { policyResult, intent, raisedFrom } = compile(requested, basePolicy);
  const { changes, clamps, requiredSources, maxSources } = policyResult;
  const summary = { changes, clamps, requiredSources, maxSources, ...(raisedFrom === null ? {} : { raisedFrom }) };
  // The team's shortlist accepts only its contract fields; sample metadata stays display-only.
  const finalists = data.finalists.map(({ address, kind, score, flags, maxDrawdown, realizedVol, cloneOf }) =>
    ({ address, kind, score, flags, maxDrawdown, realizedVol, cloneOf }));
  // Main fixes the risk window at 2M. Widen only conservative selection, then retain N.
  const limit = windowLimit(intent, maxSources);
  const addresses = intent.riskStyle === "conservative"
    ? shortlist(finalists, { ...intent, maxSources: limit }, limit).slice(0, maxSources)
    : shortlist(finalists, intent, maxSources);
  return { policyResult, intent, policy: summary, shortlist: { addresses, dataSource: data.dataSource } };
};
const rounded = (n: number | null) => n === null ? null : Math.round(n * 10000) / 10000;
export const explainSelection = (intent: StrategyIntent, basePolicy: Policy, data: Data, previous?: string[]): { evidence: WalletEvidence[]; changes?: WalletChanges } => {
  const selection = selectStrategy(intent, basePolicy, data);
  const addresses = selection.shortlist.addresses;
  const scoreOrder = [...data.finalists].filter(f => f.score !== null && Number.isFinite(f.score)).sort((a, b) => b.score! - a.score! || (a.address < b.address ? -1 : 1));
  const eligible = scoreOrder.filter(f => !f.flags.some(flag => excluded.includes(flag)) && !(intent.avoidClones && f.cloneOf !== false));
  const tags = (f: FinalistLike): string[] => [
    ...(f.maxDrawdown !== null && f.maxDrawdown < VIBE_THRESHOLDS.calmDrawdown ? ["low drawdown"] : f.maxDrawdown !== null && f.maxDrawdown >= VIBE_THRESHOLDS.wildDrawdown ? ["high drawdown"] : []),
    ...(f.realizedVol !== null && f.realizedVol < VIBE_THRESHOLDS.calmVol ? ["low vol"] : f.realizedVol !== null && f.realizedVol >= VIBE_THRESHOLDS.wildVol ? ["high vol"] : []),
    ...(intent.avoidClones ? ["clone-checked"] : []), "score selected",
  ];
  const evidence = addresses.map(address => {
    const f = data.finalists.find(f => f.address === address)!;
    const originalRank = (f as FinalistLike & { rank?: number }).rank;
    return { address, rank: originalRank ?? scoreOrder.findIndex(f => f.address === address) + 1,
      maxDrawdown: rounded(f.maxDrawdown), realizedVol: rounded(f.realizedVol), tags: tags(f) };
  });
  const reason = (address: string) => {
    const f = data.finalists.find(f => f.address === address)!;
    const flag = excluded.find(flag => f.flags.includes(flag));
    if (flag) return `flagged: ${flag}`;
    if (f.score === null) return "unranked";
    if (intent.avoidClones && f.cloneOf !== false) {
      const clone = (f as FinalistLike & { cloneAddress?: string }).cloneAddress;
      return clone && /^[\w.:-]{1,66}$/.test(clone) ? `clone of ${clone}` : "clone excluded";
    }
    if (intent.riskStyle === "aggressive") return "ranked below the new source limit";
    if (eligible.findIndex(f => f.address === address) >= 2 * windowLimit(intent, selection.policy.maxSources)) return "outside the style score window";
    return "lower priority for this style";
  };
  return { evidence, ...(previous === undefined ? {} : { changes: {
    added: addresses.filter(id => !previous.includes(id)).map(address => ({ address, reason: evidence.find(e => e.address === address)!.tags[0] })),
    removed: previous.filter(id => !addresses.includes(id)).map(address => ({ address, reason: reason(address) })),
  } }) };
};

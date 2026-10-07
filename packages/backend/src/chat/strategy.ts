// Selection and evidence for chat, Live and saved previews, using the shared shortlist.
// Only style, source limit and clone filtering affect picks; never rewrite Score or policy.
import type { Policy } from "../../../shared/src/contracts";
import { shortlist, type FinalistLike, type StrategyIntent } from "../../../shared/strategy-intent";
import type { WalletEvidence, WalletChanges } from "../../../shared/wallet-evidence";
import type { DisplayFinalist } from "./finalists";
import { VIBE_THRESHOLDS } from "../../../shared/wallet-persona";
type Data = { finalists: FinalistLike[]; dataSource: "live" | "sample" };
const excluded = ["overflow", "ruin", "low-coverage", "no-intervals"];
// A wider conservative score window lets calm candidates enter when switching from a larger score-led list.
// This changes shortlist priority only, never Score or policy.
const windowLimit = (intent: StrategyIntent, cap: number) => intent.riskStyle === "conservative" ? Math.min(25, Math.ceil(cap * 1.2)) : cap;
export const selectStrategy = (intent: StrategyIntent, _basePolicy: Policy, data: Data) => {
  const maxSources = intent.maxSources;
  // Empty arrays preserve the response shape; preferences never modify the base policy.
  const summary = { changes: [], clamps: [], maxSources };
  // The team's shortlist accepts only its contract fields; sample metadata stays display-only.
  const finalists = data.finalists.map(({ address, kind, score, flags, maxDrawdown, realizedVol, cloneOf }) =>
    ({ address, kind, score, flags, maxDrawdown, realizedVol, cloneOf }));
  // The shared shortlist fixes the risk window at 2M. Widen only conservative selection, then retain N.
  const limit = windowLimit(intent, maxSources);
  const addresses = intent.riskStyle === "conservative"
    ? shortlist(finalists, { ...intent, maxSources: limit }, limit).slice(0, maxSources)
    : shortlist(finalists, intent, maxSources);
  return { intent, policy: summary, shortlist: { addresses, dataSource: data.dataSource } };
};
const rounded = (n: number | null) => n === null ? null : Math.round(n * 10000) / 10000;
function evidenceTags(f: Pick<WalletEvidence, "maxDrawdown" | "realizedVol">, avoidClones: boolean): string[] {
  return [
    ...(f.maxDrawdown !== null && f.maxDrawdown < VIBE_THRESHOLDS.calmDrawdown ? ["low drawdown"] : f.maxDrawdown !== null && f.maxDrawdown >= VIBE_THRESHOLDS.wildDrawdown ? ["high drawdown"] : []),
    ...(f.realizedVol !== null && f.realizedVol < VIBE_THRESHOLDS.calmVol ? ["low vol"] : f.realizedVol !== null && f.realizedVol >= VIBE_THRESHOLDS.wildVol ? ["high vol"] : []),
    ...(avoidClones ? ["clone-checked"] : []), "score selected",
  ];
}

function removalReason(address: string, intent: StrategyIntent, data: Data, eligible: FinalistLike[], maxSources: number): string {
  const f = data.finalists.find(f => f.address === address)!;
  const flag = excluded.find(flag => f.flags.includes(flag));
  if (flag) return `flagged: ${flag}`;
  if (f.score === null) return "unranked";
  if (intent.avoidClones && f.cloneOf !== false) {
    const clone = (f as FinalistLike & { cloneAddress?: string }).cloneAddress;
    return clone && /^[\w.:-]{1,66}$/.test(clone) ? `clone of ${clone}` : "clone excluded";
  }
  if (intent.riskStyle === "aggressive") return "ranked below the new source limit";
  if (eligible.findIndex(f => f.address === address) >= 2 * windowLimit(intent, maxSources)) return "outside the style score window";
  return "lower priority for this style";
}

export const explainSelection = (intent: StrategyIntent, basePolicy: Policy, data: Data, previous?: string[]): { evidence: WalletEvidence[]; changes?: WalletChanges } => {
  const selection = selectStrategy(intent, basePolicy, data);
  const addresses = selection.shortlist.addresses;
  const scoreOrder = [...data.finalists].filter(f => f.score !== null && Number.isFinite(f.score)).sort((a, b) => b.score! - a.score! || (a.address < b.address ? -1 : 1));
  const eligible = scoreOrder.filter(f => !f.flags.some(flag => excluded.includes(flag)) && !(intent.avoidClones && f.cloneOf !== false));
  const evidence = addresses.map(address => {
    const f = data.finalists.find(f => f.address === address)!;
    const display = f as DisplayFinalist;
    const originalRank = display.rank;
    const metrics = { maxDrawdown: rounded(f.maxDrawdown), realizedVol: rounded(f.realizedVol) };
    return { address, rank: originalRank ?? scoreOrder.findIndex(f => f.address === address) + 1,
      ...metrics, tags: evidenceTags(metrics, intent.avoidClones), ...(data.dataSource === "live" ? {
        periodReturn: rounded(typeof display.periodReturn === "number" && Number.isFinite(display.periodReturn) ? display.periodReturn : null),
        sharpe: rounded(typeof display.sharpe === "number" && Number.isFinite(display.sharpe) ? display.sharpe : null),
      } : {}) };
  });
  return { evidence, ...(previous === undefined ? {} : { changes: {
    added: addresses.filter(id => !previous.includes(id)).map(address => ({ address, reason: evidence.find(e => e.address === address)!.tags[0] })),
    removed: previous.filter(id => !addresses.includes(id)).map(address => ({ address, reason: removalReason(address, intent, data, eligible, selection.policy.maxSources) })),
  } }) };
};

import type { Policy } from "../../../shared/src/contracts";
import { intentToPolicy, shortlist, type FinalistLike, type StrategyIntent } from "../../../shared/strategy-intent";

export const selectStrategy = (intent: StrategyIntent, basePolicy: Policy, data: {
  finalists: FinalistLike[]; dataSource: "live" | "sample";
}) => {
  const policyResult = intentToPolicy(intent, basePolicy);
  const { policy, ...summary } = policyResult;
  const addresses = shortlist(data.finalists, intent, summary.effectiveMaxSources);
  return { policyResult, policy: summary, shortlist: { addresses, dataSource: data.dataSource } };
};

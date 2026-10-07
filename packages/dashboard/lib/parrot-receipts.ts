import type { Decision, Relation } from "../../shared/receipt";
export { isDecision } from "../../shared/receipt";
export const PRESETS = [
  "Wallet A had the smaller drawdown.", "Wallet B had a higher Sharpe than Wallet A.",
  "Wallet A had a higher Sharpe than Wallet B.", "Wallet B's drawdown was only 8%.",
  "Wallet A charged lower fees.", "These two wallets trade different coins.",
];
export type Verdict = Pick<Decision, "supported" | "relation" | "relationProbabilities">;
// Hand-authored illustrations; no invented request, usage or timing telemetry.
export const CACHED: Verdict[] = [
  { supported: .98, relation: "faithful", relationProbabilities: { faithful: .98, contradicted: .005, unestablished: .005, ambiguous: .01 } },
  { supported: .99, relation: "faithful", relationProbabilities: { faithful: .99, contradicted: .003, unestablished: .003, ambiguous: .004 } },
  { supported: .01, relation: "contradicted", relationProbabilities: { faithful: .01, contradicted: .98, unestablished: .005, ambiguous: .005 } },
  { supported: .02, relation: "contradicted", relationProbabilities: { faithful: .02, contradicted: .97, unestablished: .005, ambiguous: .005 } },
  { supported: .03, relation: "unestablished", relationProbabilities: { faithful: .03, contradicted: .01, unestablished: .95, ambiguous: .01 } },
  { supported: .04, relation: "unestablished", relationProbabilities: { faithful: .04, contradicted: .01, unestablished: .94, ambiguous: .01 } },
];
// The two questions can disagree (a real run labelled "Wallet A had the higher Sharpe." faithful with 0% support).
// Show that honestly as UNCLEAR instead of trusting either answer alone.
export const settle = (v: Pick<Verdict, "supported" | "relation">): Relation =>
  v.relation === "faithful" ? (v.supported < .5 ? "ambiguous" : "faithful") : v.supported >= .5 ? "ambiguous" : v.relation;
export const disagrees = (v: Pick<Verdict, "supported" | "relation">) => settle(v) === "ambiguous" && v.relation !== "ambiguous";
export const STAMPS: Record<Relation, string> = { faithful: "MATCHES", contradicted: "CONTRADICTED", unestablished: "NOT ON THE RECEIPT", ambiguous: "UNCLEAR" };
export const CAPTIONS: Record<Relation, string> = { faithful: "Squawk! The paper backs my beak!", contradicted: "Brawk! My beak wrote a check the receipt can't cash.", unestablished: "No crumbs of evidence. Snip!", ambiguous: "Two readings, one tiny bird brain. Unclear!" };

import { selectStrategy } from "../src/chat/strategy";
import { loadFinalists } from "../src/chat/finalists";
import fixture from "../fixtures/frozen-configuration.json";
import type { Policy } from "../../shared/src/contracts";
import type { StrategyIntent } from "../../shared/strategy-intent";
export const intents: Record<string, StrategyIntent> = Object.fromEntries([
  ["safe/few", { riskStyle: "conservative", maxSources: 6, leverageComfort: "low", diversification: "high" }],
  ["balanced", {}], ["aggressive/many", { riskStyle: "aggressive", maxSources: 14, leverageComfort: "high" }],
  ["clones/on", { avoidClones: false }], ["clones/off", { avoidClones: true }],
  ["diverse", { diversification: "high" }], ["low leverage", { leverageComfort: "low" }],
  ["clamped", { requestedLeverage: 100 }],
].map(([name, patch]) => [name, { riskStyle: "balanced", maxSources: 12, diversification: "med", leverageComfort: "med",
  requestedLeverage: null, avoidClones: true, horizon: "medium", reply: "Code checked.", clarify: null, ...patch as object }]));
if (import.meta.main) {
  const data = await loadFinalists();
  const selections = Object.entries(intents).map(([name, intent]) => ({ name, ids: selectStrategy(intent, fixture.policy as Policy, data).shortlist.addresses }));
  for (const row of selections) console.log(`${row.name}: ${row.ids.length} [${row.ids.join(", ")}]`);
  console.log("from -> to: kept / in / out; turnover = (in + out) / (before + after)");
  for (let i = 0; i < selections.length; i++) for (let j = i + 1; j < selections.length; j++) {
    const a = selections[i], b = selections[j], kept = a.ids.filter(id => b.ids.includes(id)).length;
    const added = b.ids.length - kept, removed = a.ids.length - kept;
    console.log(`${a.name} -> ${b.name}: ${kept} / ${added} / ${removed}; ${Math.round(100 * (added + removed) / (a.ids.length + b.ids.length))}%`);
  }
}

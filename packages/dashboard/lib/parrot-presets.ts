import type { StrategyIntent } from "../../shared/parrot-intent";
import type { ChatResponse, PreviewResponse } from "./parrot";

export type ParrotPreset = { id: string; label: string; message: string; chat: ChatResponse; preview: PreviewResponse };
// Hand-authored illustrations, never a source of verification or actual saved requests.
const addresses = [
  "0x1111111111111111111111111111111111111111", "0x2222222222222222222222222222222222222222",
  "0x3333333333333333333333333333333333333333", "0x4444444444444444444444444444444444444444",
  "0x5555555555555555555555555555555555555555", "0x6666666666666666666666666666666666666666",
];
function preset(id: string, label: string, message: string, intent: StrategyIntent, policy: ChatResponse["policy"], leverage: number, cash: number, ceiling: number, hash: string): ParrotPreset {
  const selected = addresses.slice(0, intent.maxSources);
  return {
    id, label, message,
    chat: { ok: true, reply: intent.reply, clarify: intent.clarify, intent, policy,
      shortlist: { addresses: selected, dataSource: "sample" }, model: "hand-authored demo", latencyMs: 0 },
    preview: { ok: true, requestId: `demo-${id}`, preview: {
      version: "1", liveEligible: policy.liveEligible, paperOnly: !policy.liveEligible, weighting: "equal",
      policy: { bucket: intent.riskStyle.toUpperCase(), mode: policy.liveEligible ? "LIVE" : "SIMULATION",
        maxGrossLeverage: leverage, maxSourceWeight: ceiling / 10000, cashBuffer: cash / 10000,
        maxPairCorrelation: 0.55, maxExposureOverlap: 0.30 },
      sources: selected.map(address => ({ address, weightUnits: (10000 - cash) / selected.length, ceilingUnits: ceiling })),
      cashUnits: cash, notes: ["Canned illustration only. Nothing is saved to a server."], previewHash: hash,
    } },
  };
}

export const PARROT_PRESETS: ParrotPreset[] = [
  preset("balanced", "Keep it balanced", "Build a balanced strategy with five sources, high diversification and no clones.",
    { riskStyle: "balanced", maxSources: 5, diversification: "high", leverageComfort: "med", requestedLeverage: null, avoidClones: true, horizon: "medium", clarify: null,
      reply: "A little balance goes a long way. Five sources, more diversification, and a 2x leverage ceiling. Code keeps this one in a paper book." },
    { liveEligible: false, effectiveMaxSources: 5, changes: [{ field: "bucket", from: "AGGRESSIVE", to: "BALANCED" }, { field: "mode", from: "LIVE", to: "SIMULATION" }, { field: "maxGrossLeverage", from: 3, to: 2 }], clamps: [], notes: ["Balanced strategies are paper only.", "Synthetic wallets illustrate the selection flow."] },
    2, 2000, 2000, "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"),
  preset("careful", "Take it slow", "I prefer a conservative paper strategy with six sources and low leverage. Avoid clones.",
    { riskStyle: "conservative", maxSources: 6, diversification: "high", leverageComfort: "low", requestedLeverage: 1, avoidClones: true, horizon: "medium", clarify: null,
      reply: "Slow wings, steady thinking. Six sources with a 1x ceiling and a generous cash buffer. This is a paper book request." },
    { liveEligible: false, effectiveMaxSources: 6, changes: [{ field: "bucket", from: "AGGRESSIVE", to: "CONSERVATIVE" }, { field: "mode", from: "LIVE", to: "SIMULATION" }, { field: "cashBuffer", from: 0.2, to: 0.4 }], clamps: [], notes: ["Conservative strategies are paper only.", "Synthetic wallets illustrate the selection flow."] },
    1, 4000, 1200, "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"),
  preset("bounded", "What about 100x?", "I want an aggressive strategy at 100x leverage, five sources and no clones.",
    { riskStyle: "aggressive", maxSources: 5, diversification: "high", leverageComfort: "high", requestedLeverage: 100, avoidClones: true, horizon: "short", clarify: null,
      reply: "100x? That's a lot of flapping! I heard your request, but code caps the leverage at 3x. You can inspect exactly where the policy drew the line." },
    { liveEligible: true, effectiveMaxSources: 5, changes: [{ field: "maxPairCorrelation", from: 0.8, to: 0.55 }], clamps: [{ field: "maxGrossLeverage", requested: 100, applied: 3 }], notes: ["Eligibility is a policy classification, never permission to trade.", "Synthetic wallets illustrate the selection flow."] },
    3, 2000, 2500, "0xcccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc"),
];

import type { StrategyIntent } from "../../shared/strategy-intent";
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
      version: "1", weighting: "equal",
      policy: { bucket: intent.riskStyle.toUpperCase(), mode: "SIMULATION",
        maxGrossLeverage: leverage, maxSourceWeight: ceiling / 10000, cashBuffer: cash / 10000,
        maxPairCorrelation: 0.55, maxExposureOverlap: 0.30 },
      sources: selected.map((address, i) => ({ address, weightUnits: Math.floor((1_000_000 - cash * 100) / selected.length) + (i < (1_000_000 - cash * 100) % selected.length ? 1 : 0), ceilingUnits: ceiling * 100 })),
      cashUnits: cash * 100, previewHash: hash,
    } },
  };
}

export const PARROT_PRESETS: ParrotPreset[] = [
  preset("balanced", "Keep it balanced", "Build a balanced strategy with five sources, high diversification and no clones.",
    { riskStyle: "balanced", maxSources: 5, diversification: "high", leverageComfort: "medium", requestedLeverage: null, avoidClones: true, horizon: "medium", clarify: null,
      reply: "A little balance goes a long way. Five sources, more diversification, and a 2.5x leverage ceiling. This is a simulation preview; an operator must review and freeze." },
    { requiredSources: 4, maxSources: 5, changes: [{ field: "bucket", from: "AGGRESSIVE", to: "BALANCED" }, { field: "mode", from: "LIVE", to: "SIMULATION" }, { field: "maxGrossLeverage", from: 3, to: 2.5 }], clamps: [] },
    2.5, 2000, 2000, "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"),
  preset("careful", "Take it slow", "I prefer a conservative simulation strategy with six sources and low leverage. Avoid clones.",
    { riskStyle: "conservative", maxSources: 6, diversification: "high", leverageComfort: "low", requestedLeverage: 1, avoidClones: true, horizon: "medium", clarify: null,
      reply: "Slow wings, steady thinking. Six sources with a 1x ceiling and a generous cash buffer. This is a simulation preview; an operator must review and freeze." },
    { requiredSources: 6, maxSources: 6, changes: [{ field: "bucket", from: "AGGRESSIVE", to: "CONSERVATIVE" }, { field: "mode", from: "LIVE", to: "SIMULATION" }, { field: "cashBuffer", from: 0.1, to: 0.35 }], clamps: [] },
    1, 3500, 1200, "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"),
  preset("bounded", "What about 100x?", "I want an aggressive strategy at 100x leverage, five sources and no clones.",
    { riskStyle: "aggressive", maxSources: 5, diversification: "high", leverageComfort: "high", requestedLeverage: 100, avoidClones: true, horizon: "short", clarify: null,
      reply: "100x? That's a lot of flapping! I heard your request, but code caps the leverage at 3x. You can inspect exactly where the policy drew the line." },
    { requiredSources: 3, maxSources: 5, changes: [{ field: "mode", from: "LIVE", to: "SIMULATION" }, { field: "maxPairCorrelation", from: 0.8, to: 0.55 }], clamps: [{ field: "maxGrossLeverage", requested: 100, applied: 3 }] },
    3, 1000, 3000, "0xcccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc"),
];

// Cached illustrations used by the Parrot page when demo mode is chosen.
// Never treat these examples as model output, verification evidence or saved requests.
import type { StrategyIntent } from "../../shared/strategy-intent";
import type { ChatResponse, PreviewResponse } from "./parrot";

export type ParrotPreset = { id: string; label: string; message: string; chat: ChatResponse; preview: PreviewResponse };
// Hand-authored illustrations, never a source of verification or actual saved requests.
const addresses = [
  "0x1111111111111111111111111111111111111111", "0x2222222222222222222222222222222222222222",
  "0x3333333333333333333333333333333333333333", "0x4444444444444444444444444444444444444444",
  "0x5555555555555555555555555555555555555555", "0x6666666666666666666666666666666666666666",
];
function preset(id: string, label: string, message: string, intent: StrategyIntent, hash: string): ParrotPreset {
  const cash = 1000, ceiling = 3000;
  const selected = addresses.slice(0, intent.maxSources);
  return {
    id, label, message,
    chat: { ok: true, reply: intent.reply, clarify: intent.clarify, intent, policy: { changes: [], clamps: [], maxSources: intent.maxSources },
      shortlist: { addresses: selected, dataSource: "sample" }, model: "hand-authored demo", latencyMs: 0 },
    preview: { ok: true, requestId: `demo-${id}`, preview: {
      approvalRequired: true, version: "1", weighting: "equal",
      policy: { bucket: "AGGRESSIVE", mode: "SIMULATION",
        maxGrossLeverage: 3, maxSourceWeight: ceiling / 10000, cashBuffer: cash / 10000,
        maxPairCorrelation: 0.8, maxExposureOverlap: 0.5 },
      sources: selected.map((address, i) => ({ address, weightUnits: Math.floor((1_000_000 - cash * 100) / selected.length) + (i < (1_000_000 - cash * 100) % selected.length ? 1 : 0), ceilingUnits: ceiling * 100 })),
      cashUnits: cash * 100, previewHash: hash,
    } },
  };
}

export const PARROT_PRESETS: ParrotPreset[] = [
  preset("balanced", "Keep it balanced", "Build a balanced strategy with five sources, high diversification and no clones.",
    { riskStyle: "balanced", maxSources: 5, diversification: "high", leverageComfort: "medium", requestedLeverage: null, avoidClones: true, horizon: "medium", clarify: null,
      reply: "A little balance goes a long way. Five wallets picked for a balanced style. Diversification and leverage are context only. This is a simulation preview; an operator must review and freeze." },
    "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"),
  preset("careful", "Take it slow", "I prefer a conservative simulation strategy with six sources and low leverage. Avoid clones.",
    { riskStyle: "conservative", maxSources: 6, diversification: "high", leverageComfort: "low", requestedLeverage: 1, avoidClones: true, horizon: "medium", clarify: null,
      reply: "Slow wings, steady thinking. Six wallets picked for a calmer style. Requested leverage is preview context only. This is a simulation preview; an operator must review and freeze." },
    "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"),
  preset("bounded", "What about 100x?", "I want an aggressive strategy at 100x leverage, five sources and no clones.",
    { riskStyle: "aggressive", maxSources: 5, diversification: "high", leverageComfort: "high", requestedLeverage: 100, avoidClones: true, horizon: "short", clarify: null,
      reply: "100x? That's a lot of flapping! Requested leverage: 100x (preview only; nothing is applied or traded). An operator must review and freeze." },
    "0xcccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc"),
];

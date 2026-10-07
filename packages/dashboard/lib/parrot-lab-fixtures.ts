// Development-only: imported only behind the lab route / overlay gates.
import { PARROT_PRESETS, type ParrotPreset } from "./parrot-presets";
import type { WalletEvidence } from "../../shared/wallet-evidence";

// 24 synthetic wallets: 0-7 calm, 8-15 steady, 16-23 wild. The lab strategies overlap on purpose, so switching shows big swaps.
export const labWallet = (i: number): WalletEvidence => {
  const mood = i < 8 ? 0 : i < 16 ? 1 : 2, k = i % 8;
  const maxDrawdown = [0.005 + k * 0.003, 0.032 + k * 0.005, 0.09 + k * 0.014][mood], realizedVol = [0.002 + k * 0.0012, 0.016 + k * 0.0016, 0.031 + k * 0.001][mood];
  return { address: `0x${String(i + 1).padStart(2, "0").repeat(20)}`, rank: i + 1, maxDrawdown, realizedVol,
    tags: [mood === 0 ? "low drawdown" : mood === 2 ? "high drawdown" : "score selected", mood === 0 ? "low vol" : mood === 2 ? "high vol" : "clone-checked"] };
};
const range = (from: number, to: number) => Array.from({ length: to - from }, (_, i) => labWallet(from + i));
const LAB: { id: string; label: string; riskStyle: "conservative" | "balanced" | "aggressive"; wallets: WalletEvidence[] }[] = [
  { id: "lab-safe", label: "Lab: safe (6)", riskStyle: "conservative", wallets: range(0, 6) },
  { id: "lab-balanced", label: "Lab: balanced (12)", riskStyle: "balanced", wallets: range(3, 15) },
  { id: "lab-aggressive", label: "Lab: aggressive (16)", riskStyle: "aggressive", wallets: range(8, 24) },
  { id: "lab-wild", label: "Lab: only the wild ones (8)", riskStyle: "aggressive", wallets: range(16, 24) },
];
export const labPresets: ParrotPreset[] = LAB.map(l => {
  const template = PARROT_PRESETS[0], n = l.wallets.length;
  return { ...template, id: l.id, label: l.label,
    chat: { ...template.chat, intent: { ...template.chat.intent, riskStyle: l.riskStyle, maxSources: n },
      policy: { ...template.chat.policy, maxSources: n },
      shortlist: { addresses: l.wallets.map(w => w.address), dataSource: "sample" }, evidence: l.wallets, changes: undefined } };
});


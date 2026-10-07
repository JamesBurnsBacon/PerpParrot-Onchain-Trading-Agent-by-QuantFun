import { PARROT_PRESETS, type ParrotPreset } from "../../lib/parrot-presets";
import type { WalletEvidence } from "../../../shared/wallet-evidence";
import type { EffectEvent } from "../../lib/wallet-board";
import { useParrotEffects } from "./ParrotEffects";

// 24 synthetic wallets: 0-7 calm, 8-15 steady, 16-23 wild. The lab strategies overlap on purpose, so switching shows big swaps.
const wallet = (i: number): WalletEvidence => {
  const mood = i < 8 ? 0 : i < 16 ? 1 : 2, k = i % 8;
  const maxDrawdown = [0.005 + k * 0.003, 0.032 + k * 0.005, 0.09 + k * 0.014][mood], realizedVol = [0.002 + k * 0.0012, 0.016 + k * 0.0016, 0.031 + k * 0.001][mood];
  return { address: `0x${String(i + 1).padStart(2, "0").repeat(20)}`, rank: i + 1, maxDrawdown, realizedVol,
    tags: [mood === 0 ? "low drawdown" : mood === 2 ? "high drawdown" : "score selected", mood === 0 ? "low vol" : mood === 2 ? "high vol" : "clone-checked"] };
};
const range = (from: number, to: number) => Array.from({ length: to - from }, (_, i) => wallet(from + i));
const LAB: { id: string; label: string; riskStyle: "conservative" | "balanced" | "aggressive"; wallets: WalletEvidence[] }[] = [
  { id: "lab-safe", label: "Lab: safe (6)", riskStyle: "conservative", wallets: range(0, 6) },
  { id: "lab-balanced", label: "Lab: balanced (12)", riskStyle: "balanced", wallets: range(3, 15) },
  { id: "lab-aggressive", label: "Lab: aggressive (16)", riskStyle: "aggressive", wallets: range(8, 24) },
  { id: "lab-wild", label: "Lab: only the wild ones (8)", riskStyle: "aggressive", wallets: range(16, 24) },
];
const labPresets: ParrotPreset[] = LAB.map(l => {
  const template = PARROT_PRESETS[0], n = l.wallets.length;
  return { ...template, id: l.id, label: l.label,
    chat: { ...template.chat, intent: { ...template.chat.intent, riskStyle: l.riskStyle, maxSources: n },
      policy: { ...template.chat.policy, maxSources: n, requiredSources: Math.min(n, 6) },
      shortlist: { addresses: l.wallets.map(w => w.address), dataSource: "sample" }, evidence: l.wallets, changes: undefined } };
});

// Development-only helper for looking at and listening to the effects without a live call.
// It is rendered only when the page is opened with ?fx=1 outside production (see page.tsx).
const SOUNDS: { label: string; event: EffectEvent; count?: number; removed?: number; clamped?: boolean }[] = [
  { label: "Start squawk", event: "start" }, { label: "Swoosh in", event: "in" }, { label: "Pop out", event: "out" },
  { label: "Strategy set: clicks + cracker + applause (6)", event: "strategy", count: 6 },
  { label: "Strategy set (12 wallets, 4 out)", event: "strategy", count: 12, removed: 4 },
  { label: "Clamp bonk", event: "clamp", clamped: true }, { label: "LOCKED IN: cracker + cymbal + applause", event: "lock" },
];

export function EffectsLab({ onPreset, onLock, onReset }: { onPreset: (preset: ParrotPreset) => void; onLock: () => void; onReset: () => void }) {
  const fx = useParrotEffects();
  const play = async (s: (typeof SOUNDS)[number]) => { await fx.sfx.unlock(); fx.sfx.play(s.event, s.count ?? 1, s.removed ?? 0, s.clamped ?? false); };
  const fever = async (kind: "strategy" | "clamp" | "lock") => { await fx.sfx.unlock(); fx.trigger(kind, 8, 3, kind === "clamp"); };
  return <aside className="fx-lab" aria-label="Effects lab (development only)">
    <strong>Effects lab <small>dev only</small></strong>
    <p>Big swaps (watch the flock, reels and fever; switch between them):</p>
    <div>{labPresets.map(preset => <button type="button" key={preset.id} onClick={() => { void fx.sfx.unlock(); onPreset(preset); }}>{preset.label}</button>)}</div>
    <p>Cached demo strategies:</p>
    <div>{PARROT_PRESETS.map(preset => <button type="button" key={preset.id} onClick={() => { void fx.sfx.unlock(); onPreset(preset); }}>{preset.label}</button>)}</div>
    <div><button type="button" onClick={onLock}>Lock request</button><button type="button" onClick={onReset}>Reset</button></div>
    <p>Fever only:</p>
    <div><button type="button" onClick={() => void fever("strategy")}>STRATEGY SET</button><button type="button" onClick={() => void fever("clamp")}>BOUNDED BY CODE</button><button type="button" onClick={() => void fever("lock")}>LOCKED IN</button></div>
    <p>Building blocks:</p>
    <div>{(["cracker", "cymbal", "applause"] as const).map(name => <button type="button" key={name} onClick={async () => { await fx.sfx.unlock(); fx.sfx.solo(name); }}>{name[0].toUpperCase() + name.slice(1)}</button>)}</div>
    <p>Sounds only:</p>
    <div>{SOUNDS.map(s => <button type="button" key={s.label} onClick={() => void play(s)}>{s.label}</button>)}</div>
    <p>Motion: <button type="button" onClick={fx.toggleCalm}>{fx.calm ? "Calm on (no motion)" : "Calm off (full motion)"}</button> Sound: <button type="button" onClick={fx.toggleSound}>{fx.sound ? "on" : "off"}</button></p>
  </aside>;
}

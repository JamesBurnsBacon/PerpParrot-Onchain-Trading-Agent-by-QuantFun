import { PARROT_PRESETS, type ParrotPreset } from "../../lib/parrot-presets";
import { labPresets } from "../../lib/parrot-lab-fixtures";
import type { EffectEvent } from "../../lib/wallet-board";
import { useParrotEffects } from "./ParrotEffects";

// Development-only helper for looking at and listening to the effects without a live call.
// It is rendered only when the page is opened with ?fx=1 outside production (see page.tsx).
const SOUNDS: { label: string; event: EffectEvent; count?: number; removed?: number; clamped?: boolean }[] = [
  { label: "Start whistle", event: "start" }, { label: "Bubble in", event: "in" }, { label: "Pop out", event: "out" },
  { label: "Strategy set: clicks + cracker + applause (6)", event: "strategy", count: 6 },
  { label: "Strategy set (12 wallets, 4 out)", event: "strategy", count: 12, removed: 4 },
  { label: "Clamp nope", event: "clamp", clamped: true }, { label: "LOCKED IN: ta-da brass", event: "lock" },
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

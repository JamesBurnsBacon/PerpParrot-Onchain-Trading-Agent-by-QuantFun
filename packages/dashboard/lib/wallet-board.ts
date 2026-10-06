import type { WalletVibe } from "../../shared/wallet-persona";
export { walletNickname, walletVibe } from "../../shared/wallet-persona";
export const walletLabel = (nickname: string, vibe: WalletVibe, change?: "new" | "removed") =>
  `${nickname}, ${vibe} vibe${change ? `, ${change}` : ""}`;

export function diffWallets(previous: readonly string[], next: readonly string[]) {
  const before = new Set(previous), after = new Set(next);
  return { added: [...after].filter(id => !before.has(id)), removed: [...before].filter(id => !after.has(id)), kept: [...after].filter(id => before.has(id)) };
}
export const barScale = (value: number | null, cap: number) => value === null || !Number.isFinite(value) || !Number.isFinite(cap) || cap <= 0 ? 0 : Math.max(0, Math.min(100, value / cap * 100));
export const changeSummary = (added: number, removed: number) => ({ chip: `+${added} in / −${removed} out`, announcement: `${added} wallets added, ${removed} removed` });
export const motionAllowed = (calm: boolean, reduced: boolean) => !calm && !reduced;
export const particleBudget = (requested: number, calm: boolean) => calm || !Number.isFinite(requested) ? 0 : Math.max(0, Math.min(24, Math.floor(requested)));
export const particleAlive = (start: number, now: number) => now >= start && now - start < 900;
export const reelSchedule = (count: number, calm: boolean) => calm || !Number.isFinite(count) ? [] : Array.from({ length: Math.max(0, Math.min(25, Math.floor(count))) }, (_, i) => ({
  at: 500 + i * Math.min(35, 350 / Math.max(1, Math.min(25, count) - 1)), pitch: 220 * 2 ** (i / 12), final: i === Math.min(25, count) - 1,
}));
export const nextCombo = (previous: { count: number; at: number }, now: number, calm: boolean) => ({
  count: calm || now < previous.at || now - previous.at > 20000 ? 1 : Math.min(5, previous.count + 1), at: now,
});
// One luminance envelope per effect, at least 1000ms apart, including rapid retriggers.
// Reels/rays move without toggling visibility; no individual card flashes.
export function flashTimeline(requested: number[]): number[] {
  const accepted: number[] = [];
  for (const at of requested.filter(Number.isFinite).sort((a, b) => a - b)) if (!accepted.length || at - accepted.at(-1)! >= 1000) accepted.push(at);
  return accepted;
}
export type EffectEvent = "strategy" | "lock" | "clamp" | "start" | "in" | "out";
export type SfxCue = { kind: "tick" | "ding" | "fever" | "stamp" | "bonk" | "squawk" | "swoosh" | "pop"; at: number; pitch: number };
export type SfxState = { enabled: boolean; unlocked: boolean; now: number; lastInput: number; lastEffect: number; calm: boolean };
export const canSound = (s: SfxState) => s.enabled && s.unlocked && s.now - s.lastInput >= 1200 && s.now - s.lastEffect >= 180;
export function scheduleSfx(event: EffectEvent, count: number, state: SfxState, removed = 0, clamped = false): SfxCue[] {
  if (!canSound(state)) return [];
  if (event === "strategy") {
    const reels = reelSchedule(count, state.calm);
    const ticks = reels; // One short tick per card, bounded to the 25-card server limit.
    return [...(clamped ? [{ kind: "bonk" as const, at: 160, pitch: 95 }] : []), { kind: "swoosh", at: 0, pitch: 250 }, ...(removed > 0 ? [{ kind: "pop" as const, at: 100, pitch: 140 }] : []), ...ticks.map(s => ({ kind: s.final ? "ding" as const : "tick" as const, at: s.at, pitch: s.pitch })),
      ...(state.calm ? [{ kind: "ding" as const, at: 0, pitch: 660 }] : [])];
  }
  if (event === "lock") return [{ kind: "stamp", at: 0, pitch: 130 }, { kind: "fever", at: 100, pitch: 440 }];
  return [{ kind: { clamp: "bonk", start: "squawk", in: "swoosh", out: "pop" }[event] as SfxCue["kind"], at: 0, pitch: event === "clamp" ? 95 : 220 }];
}

// Pure board diffs, motion limits and sound scheduling used by wallet UI and effects.
// Presentation only: never choose wallets, modify policy or claim execution.
import type { ChatResponse } from "./parrot";
import type { WalletVibe } from "../../shared/wallet-persona";
export { walletNickname, walletVibe } from "../../shared/wallet-persona";
export const walletLabel = (nickname: string, vibe: WalletVibe, change?: "new" | "removed") =>
  `${nickname}, ${vibe} vibe${change ? `, ${change}` : ""}`;

export function diffWallets(previous: readonly string[], next: readonly string[]) {
  const before = new Set(previous), after = new Set(next);
  return { added: [...after].filter(id => !before.has(id)), removed: [...before].filter(id => !after.has(id)), kept: [...after].filter(id => before.has(id)) };
}
type WalletGhost = { expiresAt: number; address: string; evidence: ChatResponse["evidence"]; reason?: string };
export type WalletBoardState = { chat: ChatResponse; before: string[]; ghosts: WalletGhost[]; epoch: number; labels: boolean };
export function updateWalletBoard(state: WalletBoardState, chat: ChatResponse, now: number): WalletBoardState {
  const diff = diffWallets(state.chat.shortlist.addresses, chat.shortlist.addresses);
  return { chat, before: state.chat.shortlist.addresses, epoch: state.epoch + 1, labels: true,
    ghosts: [...state.ghosts.filter(g => !chat.shortlist.addresses.includes(g.address)), ...diff.removed.map(address => ({
      address, expiresAt: now + 2500, evidence: state.chat.evidence, reason: chat.changes?.removed.find(e => e.address === address)?.reason,
    }))].slice(-25) };
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
export const canTriggerEffect = (now: number, lastAccepted: number | null): boolean =>
  Number.isFinite(now) && (lastAccepted === null || now - lastAccepted >= 1000);
export function flashTimeline(requested: number[]): number[] {
  const accepted: number[] = [];
  for (const at of requested) if (canTriggerEffect(at, accepted.at(-1) ?? null)) accepted.push(at);
  return accepted;
}
export type EffectEvent = "strategy" | "lock" | "clamp" | "start" | "in" | "out";
export type SfxCue = { kind: "tick" | "pop" | "bubble" | "whistle" | "nope" | "sprinkle" | "tada"; at: number; pitch: number };
type SfxState = { enabled: boolean; unlocked: boolean; now: number; lastInput: number; lastEffect: number; calm: boolean };
export const canSound = (s: SfxState) => s.enabled && s.unlocked && s.now - s.lastInput >= 1200 && s.now - s.lastEffect >= 180;
// The boundary cue is retained for lab auditions; product selection never adjusts policy.
function strategyCues(count: number, calm: boolean, removed: number, clamped: boolean): SfxCue[] {
  const cues: SfxCue[] = [];
  if (clamped) cues.push({ kind: "nope", at: 160, pitch: 95 });
  cues.push({ kind: "bubble", at: 0, pitch: 250 });
  if (removed > 0) cues.push({ kind: "pop", at: 100, pitch: 140 });
  // One short tick per card, with a sprinkle on the last card, bounded to 25 cards.
  for (const reel of reelSchedule(count, calm)) {
    cues.push({ kind: reel.final ? "sprinkle" : "tick", at: reel.at, pitch: reel.pitch });
  }
  if (calm) cues.push({ kind: "sprinkle", at: 0, pitch: 660 });
  return cues;
}

export function scheduleSfx(event: EffectEvent, count: number, state: SfxState, removed = 0, clamped = false): SfxCue[] {
  if (!canSound(state)) return [];
  if (event === "strategy") return strategyCues(count, state.calm, removed, clamped);
  if (event === "lock") return [{ kind: "tada", at: 0, pitch: 440 }];
  const kind = { clamp: "nope", start: "whistle", in: "bubble", out: "pop" }[event] as SfxCue["kind"];
  return [{ kind, at: 0, pitch: event === "clamp" ? 95 : 220 }];
}

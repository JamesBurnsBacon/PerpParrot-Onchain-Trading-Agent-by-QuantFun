// Development-only pure orchestration: the same six moments and reel timing as the product.
import { findSound, SOUND_CATALOG } from "./parrot-sfx-catalog";
import { scheduleSfx, type SfxCue } from "./wallet-board";
export const MOMENTS = ["Start", "Wallet swoosh-in", "Wallet out", "Strategy set", "Clamp", "Locked in"] as const;
export type Moment = typeof MOMENTS[number];
export type Picks = Record<Moment, string>;
export const DEFAULT_PICKS: Picks = { Start: "whistle", "Wallet swoosh-in": "bubble", "Wallet out": "pop", "Strategy set": "metal-shower", Clamp: "nope", "Locked in": "ta-da" };
const cueMoments: Record<SfxCue["kind"], Moment> = { whistle: "Start", bubble: "Wallet swoosh-in", pop: "Wallet out", sprinkle: "Strategy set", tick: "Strategy set", nope: "Clamp", tada: "Locked in" };
export type ScenarioStep = { at: number; moment: Moment; soundId: string; pitch: number };
export function buildScenario(picks: Picks, count = 6, calm = false): ScenarioStep[] {
  const n = Number.isFinite(count) ? Math.max(1, Math.min(25, Math.floor(count))) : 6;
  const state = { enabled: true, unlocked: true, now: 0, lastInput: -Infinity, lastEffect: -Infinity, calm };
  return ([{ event: "start", at: 0 }, { event: "strategy", at: 1400 }, { event: "lock", at: 4400 }] as const)
    .flatMap(({event, at}) => scheduleSfx(event, n, state, 1, true).map(cue => {
      const moment = cueMoments[cue.kind];
      const fixed = cue.kind === "tick";
      const soundId = fixed ? SOUND_CATALOG.find(s => s.cueKind === cue.kind)!.id : findSound(picks[moment])?.id ?? DEFAULT_PICKS[moment];
      return { at: at + cue.at, moment, soundId, pitch: cue.pitch };
    })).sort((a,b) => a.at-b.at);
}
export const copyPicks = (picks: Picks) => MOMENTS.map(moment => `${moment} = ${findSound(picks[moment])?.label ?? findSound(DEFAULT_PICKS[moment])!.label}`).join("; ");

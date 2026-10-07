// Development-only recipes. Never import this module from product code.
import type { ParrotSoundKit } from "./parrot-sfx";
import type { SfxCue } from "./wallet-board";
export const CATALOG_MARKER = "PARROT_MATERIALS_RECIPES_DEV_ONLY_V1";
export type SoundMaterial = {
  id: string; group: "Celebrate" | "Reels / cards" | "Alerts / limits" | "Character";
  label: string; usedNow: boolean; goodFor: string; cueKind?: SfxCue["kind"]; play: (kit: ParrotSoundKit) => void;
};
const cue = (id: string, group: SoundMaterial["group"], label: string, kind: SfxCue["kind"], goodFor: string): SoundMaterial =>
  ({ id, group, label, usedNow: true, goodFor, cueKind: kind, play: k => k.cue({ kind, at: 0, pitch: 220 }) });
const extra = (id: string, group: SoundMaterial["group"], label: string, goodFor: string, recipe: (k: ParrotSoundKit, t: number) => void): SoundMaterial =>
  ({ id, group, label, goodFor, usedNow: false, play: k => recipe(k, k.now()) });
export const SOUND_CATALOG: readonly SoundMaterial[] = [
  extra("cracker", "Celebrate", "Cracker (party popper)", "Try for a quick pop accent", (k,t) => k.cracker(t,1)),
  extra("crash", "Celebrate", "Crash cymbal", "Try for a big finish; part of the current Locked in mix", (k,t) => k.cymbal(t,1,1.3)),
  extra("ride", "Celebrate", "Cymbal tap", "Try for a small accent", (k,t) => k.cymbal(t,.35,.3)),
  extra("applause-short", "Celebrate", "Applause (short)", "Try for a quick acknowledgement", (k,t) => k.applause(t,.9,.38)),
  extra("applause-long", "Celebrate", "Applause (long)", "Try for a longer finish", (k,t) => k.applause(t,1.8,.5)),
  extra("cheer", "Celebrate", "Applause + cheer swell", "Try for a friendly group cheer", (k,t) => {
    k.applause(t,1.6,.4);
    for(let i=0;i<8;i++) for(const f of [750,1200]) k.noise(t+i*.12,.3,"bandpass",f,f*1.12,.07*Math.sin((i+1)*Math.PI/9));
  }),
  extra("cracker-applause", "Celebrate", "Cracker + applause (short)", "Try for a final reel finish", (k,t) => { k.cracker(t); k.applause(t+.08,.9,.38); }),
  extra("cymbal-applause-cracker", "Celebrate", "Cymbal + applause + cracker", "Try for a big banner finish", (k,t) => { k.cymbal(t,1,1.3); k.applause(t+.05,1.6,.5); k.cracker(t+.18,.8); }),
  extra("cymbal-applause", "Celebrate", "Cymbal + applause", "Try for a finish without the popper", (k,t) => { k.cymbal(t,.8,1.2); k.applause(t+.05,1.6,.4); }),
  extra("party-horn", "Celebrate", "Party horn", "Try for a playful announcement", (k,t) => { k.tone(t,.6,330,392,"sawtooth",.12); k.tone(t,.6,415,466,"square",.06); }),
  // A familiar metallic sound, with a neutral label: no reward or money metaphor in the UI.
  cue("metal-shower", "Celebrate", "Metallic sprinkle", "sprinkle", "Strategy set: final reel finish"),
  extra("drum-cymbal", "Celebrate", "Drum roll → cymbal", "Try for a short reveal", (k,t) => { for(let i=0;i<12;i++) k.noise(t+i*.045,.04,"bandpass",1800,900,.08+i*.007); k.cymbal(t+.6,.8,1.2); }),
  cue("ta-da", "Celebrate", "Ta-da brass", "tada", "Locked in: two-note reveal"),
  extra("bell", "Celebrate", "Simple bell ding", "Try for a gentle finish", (k,t) => { k.tone(t,.8,880,880,"sine",.2); k.tone(t,.4,1760,1760,"sine",.05); }),
  extra("sparkle", "Celebrate", "Sparkle chime / harp", "Try for a rising flourish", (k,t) => [523,659,784,1047,1319,1568].forEach((f,i) => k.tone(t+i*.09,.5,f,f,"sine",.12))),
  cue("reel-click", "Reels / cards", "Reel click", "tick", "Strategy set: each intermediate reel"),
  extra("click-run", "Reels / cards", "Rising click run", "Try for cards settling", (k,t) => { for(let i=0;i<8;i++) k.noise(t+i*.06,.03,"bandpass",2600+i*120,2000+i*120,.12); }),
  extra("whoosh", "Reels / cards", "Whoosh", "Try for an arriving flock", (k,t) => k.noise(t,.22,"bandpass",500,2600,.16)),
  extra("soft-swoosh", "Reels / cards", "Soft swoosh", "Try for a gentle arrival", (k,t) => k.noise(t,.35,"bandpass",400,1800,.08)),
  cue("pop", "Reels / cards", "Pop", "pop", "Wallet out: departing flock"),
  extra("ratchet", "Reels / cards", "Reel ratchet", "Try for a mechanical card shuffle", (k,t) => { for(let i=0;i<12;i++) k.noise(t+i*.045,.02,"highpass",3200,1800,.09); }),
  cue("bubble", "Reels / cards", "Bubble pop", "bubble", "Wallet in: arriving flock"),
  extra("bonk", "Alerts / limits", "Cartoon bonk", "Try for a boundary", (k,t) => k.tone(t,.22,170,55,"triangle",.34,true)),
  extra("boing", "Alerts / limits", "Spring boing", "Try for a playful boundary", (k,t) => k.tone(t,.5,340,90,"triangle",.2,true)),
  cue("nope", "Alerts / limits", "Soft nope", "nope", "Clamp: bounded by code"),
  extra("wah", "Alerts / limits", "Gentle wah-wah", "Try for a soft correction", (k,t) => { k.tone(t,.28,400,230,"sawtooth",.07); k.tone(t+.3,.35,350,160,"sawtooth",.07); }),
  extra("single-squawk", "Character", "Parrot squawk (single)", "Try for a short greeting", (k,t) => k.tone(t,.26,780,260,"sawtooth",.18,true)),
  extra("double-squawk", "Character", "Double squawk", "Try for a two-part greeting", (k,t) => { k.tone(t,.26,780,260,"sawtooth",.18,true); k.tone(t+.24,.16,920,380,"sawtooth",.14,true); }),
  cue("whistle", "Character", "Parrot whistle", "whistle", "Start: the parrot greets"),
  extra("kazoo", "Character", "Kazoo toot", "Try for a comic greeting", (k,t) => k.tone(t,.3,220,240,"sawtooth",.1,true)),
];
export const findSound = (id: string) => SOUND_CATALOG.find(s => s.id === id);

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
  cue("cracker", "Celebrate", "Cracker (party popper)", "stamp", "Locked in: opening stamp"),
  extra("crash", "Celebrate", "Crash cymbal", "Try for a big finish; part of the current Locked in mix", (k,t) => k.cymbal(t,1,1.3)),
  extra("ride", "Celebrate", "Cymbal tap", "Try for a small accent", (k,t) => k.cymbal(t,.35,.3)),
  extra("applause-short", "Celebrate", "Applause (short)", "Try for a quick acknowledgement", (k,t) => k.applause(t,.9,.38)),
  extra("applause-long", "Celebrate", "Applause (long)", "Try for a longer finish", (k,t) => k.applause(t,1.8,.5)),
  extra("cheer", "Celebrate", "Applause + cheer swell", "Try for a friendly group cheer", (k,t) => {
    k.applause(t,1.6,.4);
    for(let i=0;i<8;i++) for(const f of [750,1200]) k.noise(t+i*.12,.3,"bandpass",f,f*1.12,.07*Math.sin((i+1)*Math.PI/9));
  }),
  cue("cracker-applause", "Celebrate", "Cracker + applause (short)", "ding", "Strategy set: final reel finish"),
  cue("cymbal-applause-cracker", "Celebrate", "Cymbal + applause + cracker", "fever", "Locked in: banner finish"),
  extra("cymbal-applause", "Celebrate", "Cymbal + applause", "Try for a finish without the popper", (k,t) => { k.cymbal(t,.8,1.2); k.applause(t+.05,1.6,.4); }),
  extra("party-horn", "Celebrate", "Party horn", "Try for a playful announcement", (k,t) => { k.tone(t,.6,330,392,"sawtooth",.12); k.tone(t,.6,415,466,"square",.06); }),
  // A familiar metallic sound, with a neutral label: no reward or money metaphor in the UI.
  extra("metal-shower", "Celebrate", "Metallic sprinkle", "Try for a bright flourish", (k,t) => { for(let i=0;i<10;i++) k.tone(t+i*.07,.18,1700+i*137,1650+i*137,"sine",.1); }),
  extra("drum-cymbal", "Celebrate", "Drum roll → cymbal", "Try for a short reveal", (k,t) => { for(let i=0;i<12;i++) k.noise(t+i*.045,.04,"bandpass",1800,900,.08+i*.007); k.cymbal(t+.6,.8,1.2); }),
  extra("ta-da", "Celebrate", "Ta-da brass", "Try for a two-note reveal", (k,t) => { for(const [offset,f] of [[0,330],[.2,440]]) { k.tone(t+offset,.3,f,f,"sawtooth",.12); k.tone(t+offset,.3,f*1.5,f*1.5,"square",.05); } }),
  extra("bell", "Celebrate", "Simple bell ding", "Try for a gentle finish", (k,t) => { k.tone(t,.8,880,880,"sine",.2); k.tone(t,.4,1760,1760,"sine",.05); }),
  extra("sparkle", "Celebrate", "Sparkle chime / harp", "Try for a rising flourish", (k,t) => [523,659,784,1047,1319,1568].forEach((f,i) => k.tone(t+i*.09,.5,f,f,"sine",.12))),
  cue("reel-click", "Reels / cards", "Reel click", "tick", "Strategy set: each intermediate reel"),
  extra("click-run", "Reels / cards", "Rising click run", "Try for cards settling", (k,t) => { for(let i=0;i<8;i++) k.noise(t+i*.06,.03,"bandpass",2600+i*120,2000+i*120,.12); }),
  cue("whoosh", "Reels / cards", "Whoosh", "swoosh", "Wallet swoosh-in: incoming flock"),
  extra("soft-swoosh", "Reels / cards", "Soft swoosh", "Try for a gentle arrival", (k,t) => k.noise(t,.35,"bandpass",400,1800,.08)),
  cue("pop", "Reels / cards", "Pop", "pop", "Wallet out: departing flock"),
  extra("ratchet", "Reels / cards", "Reel ratchet", "Try for a mechanical card shuffle", (k,t) => { for(let i=0;i<12;i++) k.noise(t+i*.045,.02,"highpass",3200,1800,.09); }),
  extra("bubble", "Reels / cards", "Bubble pop", "Try for a light card accent", (k,t) => k.tone(t,.12,420,1200,"sine",.2)),
  cue("bonk", "Alerts / limits", "Cartoon bonk", "bonk", "Clamp: bounded by code"),
  extra("boing", "Alerts / limits", "Spring boing", "Try for a playful boundary", (k,t) => k.tone(t,.5,340,90,"triangle",.2,true)),
  extra("nope", "Alerts / limits", "Soft nope", "Try for a gentle boundary", (k,t) => { k.tone(t,.18,330,330,"triangle",.13); k.tone(t+.2,.22,262,262,"triangle",.13); }),
  extra("wah", "Alerts / limits", "Gentle wah-wah", "Try for a soft correction", (k,t) => { k.tone(t,.28,400,230,"sawtooth",.07); k.tone(t+.3,.35,350,160,"sawtooth",.07); }),
  extra("single-squawk", "Character", "Parrot squawk (single)", "Try for a short greeting", (k,t) => k.tone(t,.26,780,260,"sawtooth",.18,true)),
  cue("double-squawk", "Character", "Double squawk", "squawk", "Start: the current two-part greeting"),
  extra("whistle", "Character", "Parrot whistle", "Try for a rising greeting", (k,t) => k.tone(t,.5,650,1400,"sine",.15)),
  extra("kazoo", "Character", "Kazoo toot", "Try for a comic greeting", (k,t) => k.tone(t,.3,220,240,"sawtooth",.1,true)),
];
export const findSound = (id: string) => SOUND_CATALOG.find(s => s.id === id);

// Web Audio synthesis and cleanup used by ParrotEffects and development auditions.
// Keep gesture, speech and teardown guards; cues never indicate trading success.
import { canSound, scheduleSfx, type EffectEvent, type SfxCue } from "./wallet-board";

// Instantiated per page. No AudioContext or sound until a user gesture.
export class ParrotSfx {
  context: AudioContext | null = null;
  enabled = true;
  calm = false;
  lastInput = -Infinity;
  private lastEffect = -Infinity;
  private master: GainNode | null = null;
  private limiter: DynamicsCompressorNode | null = null;
  private noiseBuffer: AudioBuffer | null = null;
  private timers = new Set<ReturnType<typeof setTimeout>>();
  private voices = new Set<AudioScheduledSourceNode>();
  async unlock() {
    try {
      this.context ??= new AudioContext();
      if (!this.master) {
        // Loud and flashy, but the compressor keeps the stacked layers from clipping.
        this.master = this.context.createGain(); this.master.gain.value = .34;
        this.limiter = this.context.createDynamicsCompressor();
        this.limiter.threshold.value = -14; this.limiter.knee.value = 12; this.limiter.ratio.value = 6; this.limiter.attack.value = .003; this.limiter.release.value = .2;
        this.master.connect(this.limiter); this.limiter.connect(this.context.destination);
      }
      await this.context.resume();
    } catch { /* Unsupported or blocked: state animation and voice element remain available. */ }
  }
  private state() { return { enabled: this.enabled, unlocked: this.context?.state === "running", now: performance.now(), lastInput: this.lastInput, lastEffect: this.lastEffect, calm: this.calm }; }
  input() { this.lastInput = performance.now(); this.cancel(); }
  play(event: EffectEvent, count = 1, removed = 0, clamped = false) {
    const cues = scheduleSfx(event, count, this.state(), removed, clamped);
    if (!cues.length) return;
    this.cancel();
    this.lastEffect = performance.now();
    for (const cue of cues) {
      const timer = setTimeout(() => {
        this.timers.delete(timer);
        // Recheck speech/mute at playback time, not just at enqueue time.
        if (canSound({ ...this.state(), lastEffect: -Infinity })) this.synth(cue);
      }, cue.at);
      this.timers.add(timer);
    }
  }
  private tone(at: number, duration: number, from: number, to: number, type: OscillatorType = "sine", volume = .22, fm = false) {
    const ctx = this.context, master = this.master;
    if (!ctx || !master || !this.enabled || ctx.state !== "running" || this.voices.size + (fm ? 2 : 1) > 192) return;
    const osc = ctx.createOscillator(), gain = ctx.createGain();
    osc.type = type; osc.frequency.setValueAtTime(from, at); osc.frequency.exponentialRampToValueAtTime(Math.max(20, to), at + duration);
    gain.gain.setValueAtTime(0, at); gain.gain.linearRampToValueAtTime(volume, at + .012); gain.gain.exponentialRampToValueAtTime(.001, at + duration);
    osc.connect(gain); gain.connect(master); this.voices.add(osc);
    let mod: OscillatorNode | undefined, depth: GainNode | undefined;
    if (fm) { mod = ctx.createOscillator(); depth = ctx.createGain(); mod.frequency.value = 37; depth.gain.value = 140; mod.connect(depth); depth.connect(osc.frequency); mod.start(at); mod.stop(at + duration); this.voices.add(mod); }
    osc.onended = () => { this.voices.delete(osc); osc.disconnect(); gain.disconnect(); if (mod) { this.voices.delete(mod); mod.disconnect(); depth?.disconnect(); } };
    osc.start(at); osc.stop(at + duration);
  }
  // Filtered noise burst: cymbal crash, whoosh, cracks and coin shimmer.
  private noise(at: number, duration: number, kind: BiquadFilterType, from: number, to: number, volume: number) {
    const ctx = this.context, master = this.master;
    if (!ctx || !master || !this.enabled || ctx.state !== "running" || this.voices.size >= 192) return;
    if (!this.noiseBuffer) {
      this.noiseBuffer = ctx.createBuffer(1, Math.ceil(ctx.sampleRate * 1.2), ctx.sampleRate);
      const data = this.noiseBuffer.getChannelData(0);
      for (let i = 0, seed = 1234567; i < data.length; i++) { seed = (seed * 1664525 + 1013904223) >>> 0; data[i] = seed / 2147483648 - 1; }
    }
    const source = ctx.createBufferSource(), filter = ctx.createBiquadFilter(), gain = ctx.createGain();
    source.buffer = this.noiseBuffer; filter.type = kind; filter.frequency.setValueAtTime(from, at); filter.frequency.exponentialRampToValueAtTime(Math.max(20, to), at + duration);
    gain.gain.setValueAtTime(0, at); gain.gain.linearRampToValueAtTime(volume, at + .008); gain.gain.exponentialRampToValueAtTime(.001, at + duration);
    source.connect(filter); filter.connect(gain); gain.connect(master); this.voices.add(source);
    source.onended = () => { this.voices.delete(source); source.disconnect(); filter.disconnect(); gain.disconnect(); };
    source.start(at); source.stop(at + duration);
  }
  // Applause: many short, randomly spaced hand-claps (band-passed noise ticks). Deterministic so it sounds the same every time.
  private applause(at: number, duration: number, volume: number) {
    let seed = 987654321;
    const rand = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
    const claps = Math.round(duration * 46);
    for (let i = 0; i < claps; i++) {
      const x = i / claps, envelope = Math.sin(Math.PI * Math.min(1, x * 1.15)) ** 0.6; // swells up, then fades out
      if (rand() > envelope) continue;
      const when = at + x * duration + rand() * .012, center = 1700 + rand() * 2200;
      this.noise(when, .028 + rand() * .02, "bandpass", center, center * .7, volume * (.35 + rand() * .65) * envelope);
    }
  }
  // Party popper: a sharp bang with a low thump, then the confetti rustling down.
  private cracker(at: number, volume = 1) {
    this.noise(at, .06, "highpass", 900, 3500, .55 * volume); this.tone(at, .09, 210, 55, "sine", .3 * volume);
    this.noise(at + .05, .32, "highpass", 5200, 4200, .12 * volume); this.noise(at + .17, .26, "highpass", 4800, 3800, .08 * volume);
  }
  // Crash cymbal: bright noise plus a few inharmonic metallic partials, long decay.
  private cymbal(at: number, volume = 1, decay = 1.2) {
    this.noise(at, decay, "highpass", 5500, 3300, .38 * volume); this.noise(at, decay * .65, "bandpass", 8200, 6200, .2 * volume);
    [2130, 3290, 4870].forEach(f => this.tone(at, .35, f, f * .98, "square", .025 * volume));
  }
  // Small bound surface for the dev catalog; all sources retain the same limiter and cancellation.
  kit() {
    return { now: () => this.context?.currentTime ?? 0, tone: this.tone.bind(this), noise: this.noise.bind(this),
      applause: this.applause.bind(this), cracker: this.cracker.bind(this), cymbal: this.cymbal.bind(this), cue: this.synth.bind(this) };
  }
  // Play one building block on its own (used by the development-only effects lab).
  solo(name: "cracker" | "cymbal" | "applause") {
    if (!this.context || !this.master || this.context.state !== "running") return;
    const t = this.context.currentTime;
    if (name === "cracker") this.cracker(t); else if (name === "cymbal") this.cymbal(t, 1, 1.3); else this.applause(t, 1.8, .5);
  }
  // Plain, familiar celebration sounds. Only the cue scheduling (tested separately) decides when they play.
  private synth(cue: SfxCue) {
    if (!this.context) return;
    const t = this.context.currentTime;
    switch (cue.kind) {
      case "tada": for (const [offset, f] of [[0, 330], [.2, 440]]) { this.tone(t + offset, .3, f, f, "sawtooth", .12); this.tone(t + offset, .3, f * 1.5, f * 1.5, "square", .05); } break;   // LOCKED IN
      case "sprinkle": for (let i = 0; i < 10; i++) this.tone(t + i * .07, .18, 1700 + i * 137, 1650 + i * 137, "sine", .1); break;                                            // STRATEGY SET
      case "tick": this.noise(t, .03, "bandpass", 2600 + cue.pitch, 2000 + cue.pitch, .12); break;                // reel click
      case "bubble": this.tone(t, .12, 420, 1200, "sine", .2); break;                                             // wallet in
      case "pop": this.tone(t, .12, 240, 55, "sine", .3); this.noise(t, .04, "lowpass", 1000, 300, .14); break;  // wallet out
      case "nope": this.tone(t, .18, 330, 330, "triangle", .13); this.tone(t + .2, .22, 262, 262, "triangle", .13); break;   // bounded by code
      case "whistle": this.tone(t, .5, 650, 1400, "sine", .15); break;                                            // parrot greets
    }
  }
  cancel() { for (const timer of this.timers) clearTimeout(timer); this.timers.clear(); for (const voice of this.voices) { try { voice.stop(); } catch {} } this.voices.clear(); }
  dispose() { this.cancel(); this.master?.disconnect(); this.master = null; this.limiter?.disconnect(); this.limiter = null; this.noiseBuffer = null; void this.context?.close().catch(() => {}); this.context = null; }
}

export type ParrotSoundKit = ReturnType<ParrotSfx["kit"]>;

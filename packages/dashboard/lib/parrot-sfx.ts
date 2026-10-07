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
    if (!ctx || !master) return;
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
    if (!ctx || !master) return;
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
  // Big, layered, over-the-top voices. Only the cue scheduling (tested separately) decides when they play.
  private synth(cue: SfxCue) {
    if (!this.context) return;
    const t = this.context.currentTime, hz = (note: number, base = 392) => base * 2 ** (note / 12);
    switch (cue.kind) {
      case "fever": {
        // Rising two-layer fanfare, a held major chord, a cymbal crash and a shower of coin sparkles.
        [0, 4, 7, 12, 16, 19, 24, 28].forEach((note, i) => {
          this.tone(t + i * .085, .24, hz(note), hz(note), "square", .11);
          this.tone(t + i * .085, .24, hz(note) * 1.006, hz(note) * 1.006, "sawtooth", .09);
        });
        [12, 16, 19, 24].forEach(note => { this.tone(t + .72, .95, hz(note), hz(note), "sawtooth", .12); this.tone(t + .72, .95, hz(note) * .995, hz(note) * .995, "square", .07); });
        this.noise(t + .72, 1.1, "highpass", 6500, 4200, .34);
        for (let i = 0; i < 12; i++) this.tone(t + .15 + i * .105, .07, 2100 + (i * 397) % 2900, 2600 + (i * 211) % 2400, "sine", .07);
        break;
      }
      case "ding":
        // Bell: inharmonic partials plus a shimmering fifth.
        this.tone(t, .6, cue.pitch, cue.pitch, "sine", .28); this.tone(t, .4, cue.pitch * 2.76, cue.pitch * 2.76, "sine", .12); this.tone(t, .25, cue.pitch * 5.4, cue.pitch * 5.4, "sine", .06);
        this.tone(t + .12, .6, cue.pitch * 1.5, cue.pitch * 1.5, "sine", .24); this.tone(t + .12, .4, cue.pitch * 4.14, cue.pitch * 4.14, "sine", .1);
        break;
      case "tick":
        this.tone(t, .07, cue.pitch * 1.4, cue.pitch * 1.1, "triangle", .2); this.noise(t, .035, "highpass", 4500, 3000, .16);
        break;
      case "swoosh":
        this.noise(t, .3, "bandpass", 300, 3800, .42); this.tone(t, .26, 180, 1500, "triangle", .14);
        break;
      case "pop":
        this.tone(t, .16, 280, 48, "sine", .42); this.noise(t, .06, "lowpass", 1100, 300, .22); this.tone(t + .03, .1, 1300, 2100, "sine", .1);
        break;
      case "stamp":
        // Heavy thud, wooden crack and a low boom.
        this.tone(t, .38, 150, 28, "sine", .55); this.noise(t, .14, "lowpass", 900, 200, .4); this.tone(t, .55, 92, 38, "triangle", .38); this.noise(t + .005, .05, "highpass", 3000, 2000, .18);
        break;
      case "bonk":
        // Cartoon boing: a thud, then a springy FM wobble.
        this.tone(t, .22, 170, 50, "triangle", .42, true); this.tone(t + .05, .5, 140, 560, "sine", .26, true); this.tone(t + .05, .5, 280, 1120, "triangle", .08);
        break;
      case "squawk":
        // Two quick squawks: "BRAWK-awk!".
        this.tone(t, .3, 820, 250, "sawtooth", .22, true); this.tone(t, .3, 1240, 520, "square", .07, true);
        this.tone(t + .26, .2, 960, 360, "sawtooth", .18, true); this.tone(t + .26, .2, 1500, 700, "square", .06, true);
        break;
    }
  }
  cancel() { for (const timer of this.timers) clearTimeout(timer); this.timers.clear(); for (const voice of this.voices) { try { voice.stop(); } catch {} } this.voices.clear(); }
  dispose() { this.cancel(); this.master?.disconnect(); this.master = null; this.limiter?.disconnect(); this.limiter = null; this.noiseBuffer = null; void this.context?.close().catch(() => {}); this.context = null; }
}

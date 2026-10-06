import { canSound, scheduleSfx, type EffectEvent, type SfxCue } from "./wallet-board";

// Instantiated per page. No AudioContext or sound until a user gesture.
export class ParrotSfx {
  context: AudioContext | null = null;
  enabled = true;
  calm = false;
  lastInput = -Infinity;
  private lastEffect = -Infinity;
  private master: GainNode | null = null;
  private timers = new Set<ReturnType<typeof setTimeout>>();
  private voices = new Set<OscillatorNode>();
  async unlock() {
    try {
      this.context ??= new AudioContext();
      if (!this.master) { this.master = this.context.createGain(); this.master.gain.value = .16; this.master.connect(this.context.destination); }
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
  private synth(cue: SfxCue) {
    if (!this.context) return;
    const t = this.context.currentTime;
    switch (cue.kind) {
      case "fever": [0, 4, 7, 12, 16].forEach((note, i) => this.tone(t + i * .14, .24, 440 * 2 ** (note / 12), 440 * 2 ** (note / 12), "sine", .18)); break;
      case "ding": this.tone(t, .28, cue.pitch, cue.pitch); this.tone(t + .13, .3, cue.pitch * 1.5, cue.pitch * 1.5); break;
      case "tick": this.tone(t, .065, cue.pitch, cue.pitch * .9, "triangle", .13); break;
      case "swoosh": this.tone(t, .24, 180, 1100, "triangle", .10); break;
      case "pop": this.tone(t, .14, 190, 45, "sine", .24); break;
      case "stamp": this.tone(t, .22, 160, 35, "triangle", .28); break;
      case "bonk": this.tone(t, .3, 160, 55, "triangle", .2, true); break;
      case "squawk": this.tone(t, .3, 580, 200, "sine", .13, true); break;
    }
  }
  cancel() { for (const timer of this.timers) clearTimeout(timer); this.timers.clear(); for (const voice of this.voices) { try { voice.stop(); } catch {} } this.voices.clear(); }
  dispose() { this.cancel(); this.master?.disconnect(); this.master = null; void this.context?.close().catch(() => {}); this.context = null; }
}

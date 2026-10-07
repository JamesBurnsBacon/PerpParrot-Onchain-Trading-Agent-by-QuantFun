import { expect, mock, spyOn, test } from "bun:test";
import { ParrotSfx } from "../lib/parrot-sfx";

test("audio disposal cancels queued cues, stops active voices and releases its context", async () => {
  const pending = new Map<number, () => void>();
  let serial = 0;
  const timer = spyOn(globalThis, "setTimeout").mockImplementation(((callback: () => void) => {
    pending.set(++serial, callback); return serial;
  }) as typeof setTimeout);
  const clear = spyOn(globalThis, "clearTimeout").mockImplementation(((id: number) => { pending.delete(id); }) as typeof clearTimeout);
  const param = () => ({ value: 0, setValueAtTime: mock(() => {}), linearRampToValueAtTime: mock(() => {}), exponentialRampToValueAtTime: mock(() => {}) });
  const gain = () => ({ gain: param(), connect: mock(() => {}), disconnect: mock(() => {}) });
  const voice = () => ({ frequency: param(), connect: mock(() => {}), disconnect: mock(() => {}), start: mock(() => {}), stop: mock((at?: number) => {}), onended: null });
  const gains: ReturnType<typeof gain>[] = [], voices: ReturnType<typeof voice>[] = [];
  const node = () => ({ connect: mock(() => {}), disconnect: mock(() => {}), start: mock(() => {}), stop: mock((at?: number) => {}), onended: null });
  const context = { state: "running", currentTime: 0, sampleRate: 8000, destination: {}, resume: mock(async () => {}), close: mock(async () => {}),
    createDynamicsCompressor: () => ({ ...node(), threshold: param(), knee: param(), ratio: param(), attack: param(), release: param() }),
    createBuffer: (_c: number, length: number) => ({ getChannelData: () => new Float32Array(length) }),
    createBufferSource: () => { const v = { ...node(), buffer: null as unknown }; voices.push(v as never); return v; },
    createBiquadFilter: () => ({ ...node(), type: "lowpass", frequency: param() }),
    createGain: () => { const g = gain(); gains.push(g); return g; },
    createOscillator: () => { const v = voice(); voices.push(v); return v; },
  };
  const sfx = new ParrotSfx();
  try {
    sfx.context = context as unknown as AudioContext;
    await sfx.unlock();
    sfx.play("strategy", 5, 1, true);
    expect(pending.size).toBeGreaterThan(1);
    // Play every queued cue except the last (bubble, pop, ticks, nope ...), so oscillators AND filtered-noise sources are live
    // before disposal while one cue is still queued.
    for (const [id, callback] of [...pending.entries()].slice(0, -1)) { pending.delete(id); callback(); }
    expect(voices.length).toBeGreaterThan(0);
    expect(voices.some(v => "buffer" in v)).toBe(true);
    expect(pending.size).toBeGreaterThan(0);
    sfx.dispose();
    expect(pending.size).toBe(0);
    for (const v of voices) expect(v.stop).toHaveBeenCalledWith();
    expect(gains[0].disconnect).toHaveBeenCalledTimes(1);
    expect(context.close).toHaveBeenCalledTimes(1);
    expect(sfx.context).toBeNull();
    sfx.dispose();
    expect(context.close).toHaveBeenCalledTimes(1);
  } finally {
    sfx.dispose(); timer.mockRestore(); clear.mockRestore();
  }
});

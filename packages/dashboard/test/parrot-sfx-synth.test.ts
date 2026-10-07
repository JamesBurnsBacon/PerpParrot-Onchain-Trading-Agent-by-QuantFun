import { expect, test } from "bun:test";
import { ParrotSfx } from "../lib/parrot-sfx";

import { fakeContext } from "./fake-audio-context";

type Synth = { synth: (cue: { kind: string; at: number; pitch: number }) => void };

test("every cue kind synthesizes without throwing, and the celebration sounds stay within a sane node budget", async () => {
  const { context, made } = fakeContext();
  const sfx = new ParrotSfx();
  sfx.context = context as unknown as AudioContext;
  await sfx.unlock();
  const counts: Record<string, number> = {};
  for (const kind of ["fever", "ding", "tick", "swoosh", "pop", "stamp", "bonk", "squawk"]) {
    const before = made.sources.length;
    expect(() => (sfx as unknown as Synth).synth({ kind, at: 0, pitch: 440 })).not.toThrow();
    counts[kind] = made.sources.length - before;
    expect(counts[kind]).toBeGreaterThan(0);
  }
  // Applause is many short claps: clearly more voices than a single bang, but bounded.
  expect(counts.fever).toBeGreaterThan(counts.stamp * 5);
  expect(counts.fever).toBeLessThan(300);
  expect(counts.ding).toBeLessThan(200);
  sfx.dispose();
  for (const v of made.sources) expect(v.stop).toHaveBeenCalled();
});

test("solo building blocks play only when the audio context is running", async () => {
  const { context, made } = fakeContext();
  const sfx = new ParrotSfx();
  sfx.context = context as unknown as AudioContext;
  sfx.solo("cracker");                      // not unlocked yet: no master chain, nothing plays
  expect(made.sources.length).toBe(0);
  await sfx.unlock();
  for (const name of ["cracker", "cymbal", "applause"] as const) { const before = made.sources.length; sfx.solo(name); expect(made.sources.length).toBeGreaterThan(before); }
  sfx.dispose();
});

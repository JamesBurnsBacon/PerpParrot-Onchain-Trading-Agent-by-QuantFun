import { expect, test } from "bun:test";
import { ParrotSfx } from "../lib/parrot-sfx";
import { SOUND_CATALOG } from "../lib/parrot-sfx-catalog";
import { fakeContext } from "./fake-audio-context";

for (const sound of SOUND_CATALOG) {
  test(`catalog sound: ${sound.id} is short, bounded, and cancel stops every source immediately`, async () => {
    const { context, made } = fakeContext(); context.currentTime = 10;
    const sfx = new ParrotSfx(); sfx.context = context as unknown as AudioContext;
    await sfx.unlock();
    try {
      expect(() => sound.play(sfx.kit())).not.toThrow();
      expect(made.sources.length).toBeGreaterThan(0);
      expect(made.sources.length).toBeLessThanOrEqual(96);
      expect(made.nodes).toBeLessThanOrEqual(288);
      for (const source of made.sources) {
        const start = source.start.mock.calls[0] as unknown as [number];
        const end = source.stop.mock.calls[0][0]!;
        expect(start[0]).toBeGreaterThanOrEqual(10);
        expect(end).toBeGreaterThan(start[0]); expect(end).toBeLessThanOrEqual(12);
        expect(source.stop).not.toHaveBeenCalledWith(); // A scheduled stop is not cancellation.
      }
      sfx.cancel();
      for (const source of made.sources) expect(source.stop).toHaveBeenCalledWith();
    } finally { sfx.dispose(); }
  });
}

test("kit node budget guard bounds repeated auditions including FM and noise", async () => {
  for (const kind of ["tone","fm","noise"] as const) {
    const {context,made} = fakeContext();
    const sfx = new ParrotSfx(); sfx.context = context as unknown as AudioContext; await sfx.unlock();
    try {
      const k = sfx.kit();
      for(let i=0;i<1000;i++) {
        if (kind === "noise") k.noise(0,.1,"bandpass",1000,500,.1);
        else k.tone(0,.1,400,200,"sine",.1,kind === "fm");
      }
      expect(made.sources.length).toBe(192);
      expect(made.nodes).toBeLessThanOrEqual(577);
      sfx.cancel(); const before = made.sources.length;
      k.cracker(0); expect(made.sources.length).toBeGreaterThan(before);
    } finally { sfx.dispose(); }
  }
});

test("kit cannot bypass unlock, mute, or a suspended context", async () => {
  const {context,made} = fakeContext();
  const sfx = new ParrotSfx(); sfx.context = context as unknown as AudioContext;
  for (const sound of SOUND_CATALOG) sound.play(sfx.kit());
  expect(made.sources.length).toBe(0);
  await sfx.unlock(); sfx.enabled = false;
  for (const sound of SOUND_CATALOG) sound.play(sfx.kit());
  expect(made.sources.length).toBe(0);
  sfx.enabled = true; context.state = "suspended";
  for (const sound of SOUND_CATALOG) sound.play(sfx.kit());
  expect(made.sources.length).toBe(0);
  sfx.dispose();
});

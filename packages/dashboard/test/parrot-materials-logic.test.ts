import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { SOUND_CATALOG } from "../lib/parrot-sfx-catalog";
import { buildScenario, copyPicks, DEFAULT_PICKS, MOMENTS } from "../lib/parrot-lab-scenario";
import { scheduleSfx, type EffectEvent } from "../lib/wallet-board";

// Exhaustive at compile time; synthesis cases are also read from the current product source.
const events: Record<EffectEvent, true> = { start: true, in: true, out: true, strategy: true, clamp: true, lock: true };
test("catalog integrity and in-use badges agree with the real scheduler and synth", () => {
  expect(SOUND_CATALOG.length).toBeGreaterThanOrEqual(24);
  expect(new Set(SOUND_CATALOG.map(s => s.id)).size).toBe(SOUND_CATALOG.length);
  for (const sound of SOUND_CATALOG) for (const value of [sound.id, sound.group, sound.label, sound.goodFor]) expect(value.trim().length).toBeGreaterThan(0);
  const scheduled = new Set(Object.keys(events).flatMap(event => [false,true].flatMap(calm => scheduleSfx(event as EffectEvent, 6, { enabled: true, unlocked: true, now: 0, lastInput: -Infinity, lastEffect: -Infinity, calm }, 1, true).map(c => c.kind))));
  const source = readFileSync(new URL("../lib/parrot-sfx.ts", import.meta.url), "utf8");
  const synthesized = [...source.matchAll(/case "([a-z]+)":/g)].map(m => m[1]).sort();
  expect([...scheduled].sort()).toEqual(synthesized);
  expect(SOUND_CATALOG.filter(s => s.usedNow).map(s => s.cueKind).sort()).toEqual(synthesized);
  expect(SOUND_CATALOG.filter(s => !s.usedNow).every(s => !s.cueKind)).toBe(true);
});

test("scenario uses picks with product order/timing, bounded reels, and calm motion", () => {
  const steps = buildScenario(DEFAULT_PICKS);
  expect(steps.filter(s => s.soundId !== "reel-click").map(s => [s.at, s.moment, s.soundId])).toEqual([
    [0,"Start","whistle"], [1400,"Wallet swoosh-in","bubble"], [1500,"Wallet out","pop"],
    [1560,"Clamp","nope"], [2075,"Strategy set","metal-shower"], [4400,"Locked in","ta-da"],
  ]);
  const chosen = Object.fromEntries(MOMENTS.map(m => [m,"bell"])) as typeof DEFAULT_PICKS;
  expect(buildScenario(chosen).filter(s => s.soundId === "bell")).toHaveLength(6);
  for (const count of [-1,0,1,25,1e9,NaN,Infinity,1.5]) {
    const result = buildScenario(DEFAULT_PICKS,count);
    expect(result.length).toBeLessThanOrEqual(31);
    expect(result.every(s => Number.isFinite(s.at) && s.at >= 0 && s.at <= 4500)).toBe(true);
    expect(result.filter(s => s.moment === "Strategy set").length).toBeLessThanOrEqual(25);
  }
  const calm = buildScenario(DEFAULT_PICKS,25,true);
  expect(calm.some(s => s.soundId === "reel-click")).toBe(false);
  expect(calm.find(s => s.moment === "Strategy set")?.at).toBe(1400);
  expect(buildScenario({...DEFAULT_PICKS, Start:"missing"})[0].soundId).toBe(DEFAULT_PICKS.Start);
});

test("copy picks is a plain-text list of every selected label", () => {
  expect(copyPicks({...DEFAULT_PICKS, "Locked in":"cymbal-applause"})).toBe("Start = Parrot whistle; Wallet swoosh-in = Bubble pop; Wallet out = Pop; Strategy set = Metallic sprinkle; Clamp = Soft nope; Locked in = Cymbal + applause");
  expect(copyPicks({...DEFAULT_PICKS, Start:"missing"})).toContain("Start = Parrot whistle");
});

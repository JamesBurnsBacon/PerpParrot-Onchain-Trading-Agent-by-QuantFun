import { expect, test } from "bun:test";
import { diffWallets, barScale, changeSummary, reelSchedule, nextCombo, particleBudget, particleAlive, motionAllowed, flashTimeline, scheduleSfx } from "../../dashboard/lib/wallet-board";
test("board diff deduplicates, preserves next order, and handles removal/reentry", () => {
  expect(diffWallets(["a", "b", "b"], ["c", "b", "c"])).toEqual({ added: ["c"], removed: ["a"], kept: ["b"] });
  expect(diffWallets(["c", "b"], ["a", "b"])).toEqual({ added: ["a"], removed: ["c"], kept: ["b"] });
  expect(changeSummary(2, 3)).toEqual({ chip: "+2 in / −3 out", announcement: "2 wallets added, 3 removed" });
  expect(barScale(null, 1)).toBe(0); expect(barScale(Infinity, 1)).toBe(0);
  expect(barScale(.25, 1)).toBe(25); expect(barScale(2, 1)).toBe(100);
});
test("reels end inside 900ms, ordered with rising pitch and one final ding", () => {
  const schedule = reelSchedule(25, false);
  expect(schedule).toHaveLength(25);
  expect(schedule[0].at).toBe(500); expect(schedule.at(-1)!.at).toBeLessThanOrEqual(900);
  expect(schedule.filter(s => s.final)).toHaveLength(1);
  for (let i = 1; i < schedule.length; i++) { expect(schedule[i].at).toBeGreaterThan(schedule[i-1].at); expect(schedule[i].pitch).toBeGreaterThan(schedule[i-1].pitch); }
  expect(reelSchedule(25, true)).toEqual([]);
});
test("combo bounded and resets on calm, inactivity and clock reversal", () => {
  expect(nextCombo({ count: 4, at: 0 }, 19000, false)).toEqual({ count: 5, at: 19000 });
  expect(nextCombo({ count: 5, at: 0 }, 19000, false).count).toBe(5);
  for (const now of [-1, 21000]) expect(nextCombo({ count: 4, at: 0 }, now, false).count).toBe(1);
  expect(nextCombo({ count: 4, at: 0 }, 1000, true).count).toBe(1);
});
test("motion and particles are bounded with exact cleanup deadline", () => {
  expect(motionAllowed(false, false)).toBe(true);
  expect(motionAllowed(true, false)).toBe(false); expect(motionAllowed(false, true)).toBe(false);
  expect(particleBudget(1000, false)).toBe(24); expect(particleBudget(24, true)).toBe(0);
  expect(particleBudget(NaN, false)).toBe(0);
  expect(particleAlive(0, 899)).toBe(true); expect(particleAlive(0, 900)).toBe(false);
});
test("sfx requires gesture and sound, skips during speech, debounces and caps reels", () => {
  const state = { enabled: true, unlocked: true, now: 5000, lastInput: 0, lastEffect: 0, calm: false };
  expect(scheduleSfx("strategy", 25, state).length).toBeLessThanOrEqual(26);
  for (const patch of [{ enabled: false }, { unlocked: false }, { lastInput: 4500 }, { lastEffect: 4900 }]) expect(scheduleSfx("strategy", 10, { ...state, ...patch })).toEqual([]);
  expect(scheduleSfx("lock", 1, { ...state, calm: true }).some(s => s.kind === "tada")).toBe(true);
  expect(scheduleSfx("strategy", 25, { ...state, calm: true }).filter(s => s.kind === "tick")).toHaveLength(0);
});
test("flash timeline caps every sliding second even across rapid retriggers", () => {
  const timeline = flashTimeline([0, 20, 50, 100, 340, 670, 990, 1010, 1300, 1500]);
  for (const start of timeline) expect(timeline.filter(t => t >= start && t < start + 1000).length).toBeLessThanOrEqual(3);
  expect(flashTimeline([0, 0, 0, 0])).toEqual([0]);
});

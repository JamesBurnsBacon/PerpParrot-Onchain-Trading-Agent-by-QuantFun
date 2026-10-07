import { expect, test } from "bun:test";
import { canTriggerEffect, flashTimeline } from "../lib/wallet-board";

test("an effect needs a full gap since the last acceptance, including ties and backwards clocks", () => {
  expect(canTriggerEffect(5000, null)).toBe(true);
  for (const now of [5000, 4999, 0, 5999, NaN, Infinity]) expect(canTriggerEffect(now, 5000)).toBe(false);
  expect(canTriggerEffect(6000, 5000)).toBe(true);
  expect(canTriggerEffect(6001, 5000)).toBe(true);
});
test("rapid triggers preserve arrival order and rejected triggers do not move the accepted time", () => {
  const requests = [5000, 5000, 4999, 0, 5100, 5999, 6000, 6000, 6500, 7000];
  let lastAccepted: number | null = null;
  const animated = requests.map(now => {
    const accept = canTriggerEffect(now, lastAccepted);
    if (accept) lastAccepted = now;
    return accept;
  });
  expect(animated).toEqual([true, false, false, false, false, false, true, false, false, true]);
  expect(flashTimeline(requests)).toEqual([5000, 6000, 7000]);
});
test("every sliding second stays within the three-flash guarantee", () => {
  const accepted = flashTimeline(Array.from({ length: 10000 }, (_, i) => Math.floor(i / 3)));
  expect(accepted).toEqual([0, 1000, 2000, 3000]);
  for (const start of accepted) expect(accepted.filter(t => t >= start && t < start + 1000).length).toBeLessThanOrEqual(3);
});

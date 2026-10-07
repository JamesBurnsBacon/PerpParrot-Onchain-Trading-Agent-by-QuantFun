import { describe, expect, it } from "vitest";
import {
  createConductor,
  type ConductorEnvironment,
  type ConductorFrame,
} from "../src/art/conductor";
function harness() {
  let hidden = false,
    id = 0,
    visibility = () => {};
  const pending = new Map<number, (time: number) => void>();
  const environment: ConductorEnvironment = {
    request: (cb) => {
      pending.set(++id, cb);
      return id;
    },
    cancel: (n) => {
      pending.delete(n);
    },
    viewport: () => ({ width: 1200, height: 800 }),
    hidden: () => hidden,
    onVisibility: (cb) => {
      visibility = cb;
      return () => {
        visibility = () => {};
      };
    },
  };
  return {
    clock: createConductor(environment),
    pending,
    step(time: number) {
      const entries = [...pending.values()];
      pending.clear();
      entries.forEach((cb) => cb(time));
    },
    hide(value: boolean) {
      hidden = value;
      visibility();
    },
  };
}
describe("shared conductor", () => {
  it("uses one scheduled frame for multiple subscribers and bounded shared time", () => {
    const h = harness(),
      a: ConductorFrame[] = [],
      b: ConductorFrame[] = [];
    h.clock.subscribe((f) => a.push(f));
    h.clock.subscribe((f) => b.push(f));
    expect(h.pending.size).toBe(1);
    h.step(100);
    h.step(10000);
    expect(a).toEqual(b);
    expect(a[1].delta).toBe(50);
    expect(a[1].phase).toBe(0.05);
    expect(a[1].viewport.width).toBe(1200);
    expect(h.pending.size).toBe(1);
    h.clock.dispose();
  });
  it("stops for hidden, pause and reduced motion without catch-up", () => {
    const h = harness(),
      frames: ConductorFrame[] = [];
    h.clock.subscribe((f) => frames.push(f));
    h.step(10);
    h.step(30);
    h.hide(true);
    expect(h.pending.size).toBe(0);
    h.hide(false);
    h.step(9999);
    expect(frames.at(-1)?.delta).toBe(0);
    expect(frames.at(-1)?.elapsed).toBe(20);
    h.clock.setPaused(true);
    expect(h.pending.size).toBe(0);
    h.clock.setPaused(false);
    expect(h.pending.size).toBe(1);
    h.clock.setReducedMotion(true);
    expect(h.pending.size).toBe(0);
    h.clock.dispose();
  });
  it("deactivates offscreen consumers and stops when none remain", () => {
    const h = harness();
    let calls = 0;
    const s = h.clock.subscribe(() => calls++);
    s.setActive(false);
    expect(h.pending.size).toBe(0);
    s.setActive(true);
    h.step(10);
    expect(calls).toBe(1);
    s.unsubscribe();
    expect(h.pending.size).toBe(0);
    h.clock.dispose();
  });
  it("disposes its frame and visibility listener permanently", () => {
    let removed = 0;
    const pending = new Map<number, (time: number) => void>();
    const clock = createConductor({
      request: (cb) => {
        pending.set(1, cb);
        return 1;
      },
      cancel: (id) => {
        pending.delete(id);
      },
      viewport: () => ({ width: 1, height: 1 }),
      hidden: () => false,
      onVisibility: () => () => {
        removed++;
      },
    });
    clock.subscribe(() => {});
    clock.dispose();
    expect(pending.size).toBe(0);
    expect(removed).toBe(1);
    expect(() => clock.subscribe(() => {})).toThrow("disposed");
  });
});

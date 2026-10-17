import { describe, expect, it } from "vitest";
import { createParrotMorph } from "../src/art/parrot-morph";
const quiet = { x: 0, y: 0, active: false };
describe("original point-cloud spring morph", () => {
  it("reproduces trajectories from seed and distinguishes other seeds", () => {
    const a = createParrotMorph(47, 100),
      b = createParrotMorph(47, 100),
      c = createParrotMorph(48, 100);
    a.burst();
    b.burst();
    a.setShape("plumage");
    b.setShape("plumage");
    for (let i = 0; i < 120; i++) {
      a.advance(16.667, quiet);
      b.advance(16.667, quiet);
    }
    expect(a.positions).toEqual(b.positions);
    expect(a.targets).not.toEqual(c.targets);
  });
  it("keeps changing shapes and repeated pointer impulses finite and bounded", () => {
    const engine = createParrotMorph(47, 100);
    for (let i = 0; i < 1000; i++) {
      if (i % 100 === 0) {
        engine.setShape(
          i % 300 === 0 ? "parrot" : i % 300 === 100 ? "orbit" : "plumage",
        );
        engine.burst();
      }
      engine.advance(i % 2 ? 16.667 : 1000, {
        x: Math.sin(i * 0.1),
        y: Math.cos(i * 0.1),
        active: true,
      });
    }
    expect(
      [...engine.positions].every(
        (value) => Number.isFinite(value) && Math.abs(value) <= 2.5,
      ),
    ).toBe(true);
  });
  it("settles after scatter toward the chosen shape without ongoing pointer input", () => {
    const engine = createParrotMorph(47, 100);
    engine.setShape("orbit");
    engine.burst();
    for (let i = 0; i < 1200; i++) engine.advance(16.667, quiet);
    const error = Math.max(
      ...engine.positions.map((value, i) =>
        Math.abs(value - engine.targets[i]),
      ),
    );
    expect(error).toBeLessThan(0.00001);
  });
  it("changes color independently from shape and physical state", () => {
    const engine = createParrotMorph(47, 100),
      positions = engine.positions.slice(),
      targets = engine.targets.slice(),
      colors = engine.colors.slice(),
      version = engine.colorVersion;
    engine.setPalette("ultraviolet");
    expect(engine.colors).not.toEqual(colors);
    expect(engine.positions).toEqual(positions);
    expect(engine.targets).toEqual(targets);
    expect(engine.colorVersion).toBe(version + 1);
  });
  it("rejects invalid allocation counts before constructing buffers", () => {
    for (const count of [0, 99, 4001, NaN, Infinity, 101.5])
      expect(() => createParrotMorph(47, count)).toThrow("Point count");
  });
  it("ignores nonfinite timing and sanitizes invalid pointer input", () => {
    const engine = createParrotMorph(47, 100),
      before = engine.positions.slice();
    engine.advance(NaN, quiet);
    engine.advance(Infinity, quiet);
    engine.advance(-Infinity, quiet);
    expect(engine.positions).toEqual(before);
    engine.burst();
    for (const active of [false, true]) {
      for (let i = 0; i < 100; i++)
        engine.advance(16.667, { x: NaN, y: Infinity, active });
    }
    expect(
      [...engine.positions].every(
        (value) => Number.isFinite(value) && Math.abs(value) <= 2.5,
      ),
    ).toBe(true);
  });
});

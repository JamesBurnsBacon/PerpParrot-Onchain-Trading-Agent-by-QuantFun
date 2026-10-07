import { describe, it, expect } from "vitest";
import {
  createFlightEngine,
  PARTICLE_COUNT,
  HISTORY_LENGTH,
  MAX_SPEED,
  FLIGHT_PALETTE,
} from "../src/art/flight-engine";
import type { FlightMode } from "../src/art/flight-engine";
describe("deterministic flight engine", () => {
  it("curl samples remain coherent under small space and time changes", () => {
    const engine = createFlightEngine({ seed: 47, mode: "flow" });
    for (const [x, y] of [
      [0.2, 0.3],
      [0.55, 0.48],
      [0.8, 0.7],
    ]) {
      const a = engine.sampleField(x, y, 1),
        b = engine.sampleField(x + 0.0001, y + 0.0001, 1.0001);
      expect([a.x, a.y, b.x, b.y].every(Number.isFinite)).toBe(true);
      expect(Math.hypot(a.x - b.x, a.y - b.y)).toBeLessThan(0.0001);
    }
  });
  it("the unmodified curl field has near-zero local numerical divergence", () => {
    const engine = createFlightEngine({ seed: 47, mode: "flow" }),
      e = 0.002;
    const xp = engine.sampleField(0.55 + e, 0.48, 1),
      xm = engine.sampleField(0.55 - e, 0.48, 1),
      yp = engine.sampleField(0.55, 0.48 + e, 1),
      ym = engine.sampleField(0.55, 0.48 - e, 1);
    expect(
      Math.abs((xp.x - xm.x) / (2 * e) + (yp.y - ym.y) / (2 * e)),
    ).toBeLessThan(1e-9);
  });
  it("uses the complete constrained symphony palette without arbitrary RGB", () => {
    const engine = createFlightEngine({ seed: 47, mode: "flow" });
    expect(new Set(engine.particles.map((p) => p.color))).toEqual(
      new Set(FLIGHT_PALETTE),
    );
  });
  it("reproduces identical states at the same tick, seed, parameters and input", () => {
    const a = createFlightEngine({ seed: 47, mode: "flow" }),
      b = createFlightEngine({ seed: 47, mode: "flow" });
    for (let i = 0; i < 80; i++) {
      const options = {
        intensity: 72,
        pointer: { x: 0.6, y: 0.4, active: i > 20 },
      };
      a.advance(options);
      b.advance(options);
    }
    expect(a.tick).toBe(80);
    expect(a.particles).toEqual(b.particles);
  });
  it("different seeds create different flight histories", () => {
    const a = createFlightEngine({ seed: 47, mode: "flow" }),
      b = createFlightEngine({ seed: 48, mode: "flow" });
    for (let i = 0; i < 40; i++) {
      a.advance();
      b.advance();
    }
    expect(a.particles).not.toEqual(b.particles);
  });
  for (const mode of ["flow", "flock", "orbit"] as FlightMode[])
    it(`${mode} maintains finite positions, limited speed and bounded history`, () => {
      const engine = createFlightEngine({ seed: 47, mode });
      for (let i = 0; i < 300; i++) engine.advance({ intensity: 100 });
      expect(engine.particles).toHaveLength(PARTICLE_COUNT);
      for (const p of engine.particles) {
        expect([p.x, p.y, p.vx, p.vy].every(Number.isFinite)).toBe(true);
        expect(Math.hypot(p.vx, p.vy)).toBeLessThanOrEqual(MAX_SPEED + 1e-12);
        expect(p.history).toHaveLength(HISTORY_LENGTH);
        expect(p.count).toBeLessThanOrEqual(HISTORY_LENGTH);
        expect(p.cursor).toBeLessThan(HISTORY_LENGTH);
        expect(p.x).toBeGreaterThanOrEqual(-0.03);
        expect(p.x).toBeLessThanOrEqual(1.03);
      }
    });
  it("ignores invalid pointer values and sanitizes nonfinite intensity", () => {
    const a = createFlightEngine({ seed: 47, mode: "flow" }),
      b = createFlightEngine({ seed: 47, mode: "flow" });
    a.advance({
      intensity: NaN,
      pointer: { x: Infinity, y: NaN, active: true },
    });
    b.advance();
    expect(a.particles).toEqual(b.particles);
  });
  it("stays unchanged without an explicit advance call", () => {
    const engine = createFlightEngine({ seed: 47, mode: "flock" });
    const before = structuredClone(engine.particles);
    expect(engine.tick).toBe(0);
    expect(engine.particles).toEqual(before);
  });
});

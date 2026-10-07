import { describe, it, expect } from "vitest";
import {
  sceneDefaults,
  sceneReducer,
  shapeForMode,
  modeForShape,
  sceneAccent,
} from "../src/art/scene-state";
describe("shared decorative scene", () => {
  it("shares seed updates regardless of initiating control", () => {
    const next = sceneReducer(sceneDefaults, { type: "seed", value: 48 });
    expect(next.seed).toBe(48);
    expect(next.palette).toBe("solar");
  });
  it("maps each sculpture shape to exactly one flight mode", () => {
    for (const mode of ["flow", "flock", "orbit"] as const)
      expect(modeForShape(shapeForMode(mode))).toBe(mode);
  });
  it("resets every art parameter and advances reset epoch even at defaults", () => {
    let state = sceneReducer(sceneDefaults, {
      type: "palette",
      value: "ultraviolet",
    });
    state = sceneReducer(state, { type: "mode", value: "orbit" });
    state = sceneReducer(state, { type: "intensity", value: 90 });
    state = sceneReducer(state, { type: "seed", value: 51 });
    const reset = sceneReducer(state, { type: "reset" });
    expect(reset).toEqual({ ...sceneDefaults, epoch: 1 });
    expect(sceneReducer(reset, { type: "reset" }).epoch).toBe(2);
  });
  it("pulses have unique IDs and preserve art seed and parameters", () => {
    const a = sceneReducer(sceneDefaults, { type: "pulse", phase: 12.4 }),
      b = sceneReducer(a, { type: "pulse", phase: 13 });
    expect(a.pulse).toEqual({ id: 1, phase: 12.4 });
    expect(b.pulse).toEqual({ id: 2, phase: 13 });
    expect(b.seed).toBe(47);
    expect(sceneReducer(b, { type: "reset" }).pulse.id).toBe(2);
  });
  it("matches selected source accent with neutral missing identity", () => {
    expect(
      sceneAccent("quiet", ["atlas", "northstar", "garden", "quiet", "orange"]),
    ).toBe("#ffac95");
    expect(sceneAccent("missing", [])).toBe("#ffe276");
  });
  it("art state cannot store financial allocation or inclusion", () => {
    expect(
      Object.keys(sceneReducer(sceneDefaults, { type: "reset" })).sort(),
    ).toEqual(["epoch", "intensity", "mode", "palette", "pulse", "seed"]);
  });
});

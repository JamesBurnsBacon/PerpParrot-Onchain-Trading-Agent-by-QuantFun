import type { FlightMode } from "./flight-engine";
import type { MorphPalette, MorphShape } from "./parrot-morph";
export type SceneState = {
  seed: number;
  mode: FlightMode;
  palette: MorphPalette;
  intensity: number;
  epoch: number;
  pulse: { id: number; phase: number };
};
export const sceneDefaults: SceneState = {
  seed: 47,
  mode: "flow",
  palette: "solar",
  intensity: 55,
  epoch: 0,
  pulse: { id: 0, phase: 0 },
};
export type SceneEvent =
  | { type: "seed"; value: number }
  | { type: "mode"; value: FlightMode }
  | { type: "palette"; value: MorphPalette }
  | { type: "intensity"; value: number }
  | { type: "reset" }
  | { type: "pulse"; phase: number };
export function sceneReducer(state: SceneState, event: SceneEvent): SceneState {
  switch (event.type) {
    case "seed":
      return { ...state, seed: event.value };
    case "mode":
      return { ...state, mode: event.value };
    case "palette":
      return { ...state, palette: event.value };
    case "intensity":
      return { ...state, intensity: Math.max(10, Math.min(100, event.value)) };
    case "pulse":
      return {
        ...state,
        pulse: { id: state.pulse.id + 1, phase: event.phase },
      };
    case "reset":
      return {
        ...sceneDefaults,
        epoch: state.epoch + 1,
        pulse: { id: state.pulse.id, phase: 0 },
      };
  }
}
export const shapeForMode = (mode: FlightMode): MorphShape =>
  mode === "flow" ? "parrot" : mode === "flock" ? "plumage" : "orbit";
export const modeForShape = (shape: MorphShape): FlightMode =>
  shape === "parrot" ? "flow" : shape === "plumage" ? "flock" : "orbit";
/** Matches the original source-feather palette; missing live identity stays neutral. */
export function sceneAccent(selectedId: string, sourceIds: string[]) {
  const index = sourceIds.indexOf(selectedId);
  return ["#ffe276", "#91d8cf", "#a7baff", "#ffac95", "#edbdff"][
    index < 0 ? 0 : index % 5
  ];
}

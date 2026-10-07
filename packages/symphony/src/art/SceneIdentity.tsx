import { createContext, useContext, useReducer, type ReactNode } from "react";
import {
  sceneDefaults,
  sceneReducer,
  sceneAccent,
  type SceneEvent,
  type SceneState,
} from "./scene-state";
import type { Source } from "../types";
import { FeatherIdentity } from "../components/FeatherIdentity";
import "./scene-identity.css";
type SceneContext = SceneState & {
  accent: string;
  dispatch: (event: SceneEvent) => void;
  sources: Source[];
  selectedId: string;
  activeIds: string[];
  demo: boolean;
  paused: boolean;
  setPaused: (value: boolean) => void;
};
const Context = createContext<SceneContext | null>(null);
export function SceneIdentityProvider({
  children,
  ...identity
}: {
  children: ReactNode;
  sources: Source[];
  selectedId: string;
  activeIds: string[];
  demo: boolean;
  paused: boolean;
  setPaused: (value: boolean) => void;
}) {
  const [state, dispatch] = useReducer(sceneReducer, sceneDefaults);
  return (
    <Context.Provider
      value={{
        ...state,
        ...identity,
        dispatch,
        accent: sceneAccent(
          identity.selectedId,
          identity.sources.map((s) => s.id),
        ),
      }}
    >
      {children}
    </Context.Provider>
  );
}
export function useSceneIdentity() {
  const scene = useContext(Context);
  if (!scene) throw new Error("Scene identity requires provider");
  return scene;
}
export function SceneSignature() {
  const scene = useSceneIdentity();
  const selected = scene.sources.find((s) => s.id === scene.selectedId);
  return (
    <div
      className="scene-signature"
      aria-label="Shared decorative scene identity"
    >
      <div className="signature-feathers">
        {scene.sources.map((source, i) => (
          <span
            key={source.id}
            className={
              (source.id === scene.selectedId ? "chosen " : "") +
              (scene.activeIds.includes(source.id) ? "included" : "muted")
            }
          >
            <FeatherIdentity id={source.id} index={i} />
          </span>
        ))}
      </div>
      <div>
        <strong>
          {scene.demo && selected ? selected.name : "Original signal identity"}
        </strong>
        <span>
          {scene.demo
            ? `${scene.activeIds.length} of ${scene.sources.length} preview voices included`
            : "Decorative reference · not live positions"}{" "}
          · Seed {scene.seed}
        </span>
        <small>
          Shared artwork identity. Targets change only through preview
          inclusion.
        </small>
      </div>
    </div>
  );
}

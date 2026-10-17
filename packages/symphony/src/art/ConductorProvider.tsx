import { createContext, useContext, useEffect } from "react";
import type { ReactNode } from "react";
import { useReducedMotion } from "motion/react";
import { getSharedConductor, releaseSharedConductor } from "./conductor";
import type { Conductor } from "./conductor";

// Stable proxy: all browser clock creation happens in effects/subscriptions.
// StrictMode teardown releases the old clock; remounts acquire a fresh one.
const sharedProxy: Conductor = {
  subscribe: (callback, options) =>
    getSharedConductor().subscribe(callback, options),
  setPaused: (value) => getSharedConductor().setPaused(value),
  setReducedMotion: (value) => getSharedConductor().setReducedMotion(value),
  dispose: () => releaseSharedConductor(),
};
const ConductorContext = createContext<Conductor | null>(null);
export function ConductorProvider({
  paused,
  children,
}: {
  paused: boolean;
  children: ReactNode;
}) {
  const reduced = useReducedMotion();
  useEffect(() => {
    sharedProxy.setPaused(paused);
    sharedProxy.setReducedMotion(Boolean(reduced));
  }, [paused, reduced]);
  useEffect(() => () => sharedProxy.dispose(), []);
  return (
    <ConductorContext.Provider value={sharedProxy}>
      {children}
    </ConductorContext.Provider>
  );
}
export function useConductor() {
  const value = useContext(ConductorContext);
  if (!value)
    throw new Error("Visual voices require the shared ConductorProvider.");
  return value;
}

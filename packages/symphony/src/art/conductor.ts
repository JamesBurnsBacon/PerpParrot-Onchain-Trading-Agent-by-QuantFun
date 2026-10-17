/** One clock for all visual voices. It owns no React state or rendering. */
export type ConductorFrame = {
  elapsed: number;
  delta: number;
  phase: number;
  viewport: { width: number; height: number };
};
export type ConductorEnvironment = {
  request: (callback: (time: number) => void) => number;
  cancel: (id: number) => void;
  viewport: () => { width: number; height: number };
  hidden: () => boolean;
  onVisibility: (callback: () => void) => () => void;
};
export type ConductorSubscription = {
  setActive: (active: boolean) => void;
  unsubscribe: () => void;
};
const browserEnvironment = (): ConductorEnvironment => ({
  request: (callback) => window.requestAnimationFrame(callback),
  cancel: (id) => window.cancelAnimationFrame(id),
  viewport: () => ({ width: window.innerWidth, height: window.innerHeight }),
  hidden: () => document.hidden,
  onVisibility: (callback) => {
    document.addEventListener("visibilitychange", callback);
    return () => document.removeEventListener("visibilitychange", callback);
  },
});
export function createConductor(
  environment: ConductorEnvironment = browserEnvironment(),
) {
  const subscribers = new Map<
    number,
    { callback: (frame: ConductorFrame) => void; active: boolean }
  >();
  let nextId = 0,
    raf: number | null = null,
    previous: number | null = null,
    elapsed = 0;
  let paused = false,
    reduced = false,
    disposed = false;
  const runnable = () =>
    !disposed &&
    !paused &&
    !reduced &&
    !environment.hidden() &&
    [...subscribers.values()].some((item) => item.active);
  const reconcile = () => {
    if (!runnable()) {
      if (raf !== null) environment.cancel(raf);
      raf = null;
      previous = null;
    } else if (raf === null) raf = environment.request(frame);
  };
  function frame(time: number) {
    raf = null;
    if (!runnable()) {
      previous = null;
      return;
    }
    const delta =
      previous === null ? 0 : Math.max(0, Math.min(50, time - previous));
    previous = time;
    elapsed += delta;
    const value: ConductorFrame = {
      elapsed,
      delta,
      phase: elapsed / 1000,
      viewport: environment.viewport(),
    };
    for (const item of [...subscribers.values()])
      if (item.active) item.callback(value);
    reconcile();
  }
  const removeVisibility = environment.onVisibility(reconcile);
  return {
    subscribe(
      callback: (frame: ConductorFrame) => void,
      options: { active?: boolean } = {},
    ): ConductorSubscription {
      if (disposed) throw new Error("Conductor has been disposed.");
      const id = ++nextId;
      subscribers.set(id, { callback, active: options.active ?? true });
      reconcile();
      return {
        setActive(active) {
          const item = subscribers.get(id);
          if (item) {
            item.active = active;
            reconcile();
          }
        },
        unsubscribe() {
          subscribers.delete(id);
          reconcile();
        },
      };
    },
    setPaused(value: boolean) {
      paused = value;
      reconcile();
    },
    setReducedMotion(value: boolean) {
      reduced = value;
      reconcile();
    },
    dispose() {
      disposed = true;
      subscribers.clear();
      reconcile();
      removeVisibility();
    },
  };
}
export type Conductor = ReturnType<typeof createConductor>;
let shared: Conductor | undefined;
/** Lazily initialized in an effect; importing this module does not touch the DOM. */
export function getSharedConductor(): Conductor {
  return (shared ??= createConductor());
}
/** Provider teardown releases listeners and permits a fresh Strict Mode mount. */
export function releaseSharedConductor(): void {
  shared?.dispose();
  shared = undefined;
}

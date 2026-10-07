// Same isolated mock-React technique as live-hook.fixture.ts; never a browser claim.
import { mock } from "bun:test";
export function hookHost() {
  let slots: any[] = [], cursor = 0, effects: (() => void)[] = [];
  const same = (a: any[], b: any[]) => a && b && a.length === b.length && a.every((v, i) => v === b[i]);
  const jsx = (type: any, props: any, key: any) => ({ type, props, key });
  mock.module("react/jsx-runtime", () => ({ jsx, jsxs: jsx, Fragment: Symbol.for("react.fragment") }));
  mock.module("react", () => ({
    useState(initial: any) { const i = cursor++; slots[i] ??= { value: typeof initial === "function" ? initial() : initial }; return [slots[i].value, (v: any) => { slots[i].value = typeof v === "function" ? v(slots[i].value) : v; }]; },
    useRef(value: any) { const i = cursor++; return slots[i] ??= { current: value }; },
    useEffect(fn: any, deps: any[]) { const i = cursor++; if (!same(slots[i]?.deps, deps)) effects.push(() => { slots[i]?.cleanup?.(); slots[i] = { deps, cleanup: fn() }; }); },
  }));
  return {
    render<T>(fn: () => T) { cursor = 0; return fn(); },
    effects() { for (const effect of effects.splice(0)) effect(); },
    unmount() { for (const slot of slots) slot?.cleanup?.(); slots = []; effects = []; },
  };
}
export function fakeClock() {
  let time = 0, serial = 0;
  const timers = new Map<number, { at: number; fn: () => void }>();
  globalThis.setTimeout = ((fn: () => void, ms = 0) => { const id = ++serial; timers.set(id, { at: time + ms, fn }); return id; }) as never;
  globalThis.clearTimeout = ((id: number) => { timers.delete(id); }) as never;
  Object.defineProperty(globalThis, "performance", { value: { now: () => time }, configurable: true });
  return { now: () => time, pending: () => timers.size, advance(ms: number) {
    const end = time + ms;
    for (;;) {
      const next = [...timers].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
      if (!next) break;
      time = next[1].at; timers.delete(next[0]); next[1].fn();
    }
    time = end;
  } };
}
export function nodes(tree: any): any[] {
  if (!tree || typeof tree !== "object") return [];
  if (Array.isArray(tree)) return tree.flatMap(nodes);
  return [tree, ...nodes(tree.props?.children)];
}
export const tick = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };

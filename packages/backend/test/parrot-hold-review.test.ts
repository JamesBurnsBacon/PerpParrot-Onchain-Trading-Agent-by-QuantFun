import { expect, test } from "bun:test";
import { canContinueHold, holdProgress, isPointerOutside } from "../../dashboard/lib/parrot";

// Execute the real component with deterministic hooks and animation frames. This
// tests handlers/closures across renders without a DOM or a React module mock.
// Browser event dispatch, capture, layout and React scheduling remain unverified.
const harness = async () => {
  const source = await Bun.file(new URL("../../dashboard/components/parrot/HoldButton.tsx", import.meta.url)).text();
  const compiled = new Bun.Transpiler({ loader: "tsx", tsconfig: { compilerOptions: { jsx: "react" } } })
    .transformSync(source.replace(/^import .*;\n/gm, "").replace("export function", "function"));
  const slots: { value?: any; deps?: unknown[]; cleanup?: () => void }[] = [];
  let cursor = 0;
  let effects: (() => void)[] = [];
  let now = 0;
  let nextFrame = 0;
  const frames = new Map<number, (time: number) => void>();
  const slot = () => slots[cursor++] ?? (slots[cursor - 1] = {});
  const changed = (before: unknown[] | undefined, after: unknown[]) => !before || after.some((v, i) => !Object.is(v, before[i]));
  const effect = (fn: () => (() => void) | void, deps: unknown[]) => {
    const s = slot();
    if (changed(s.deps, deps)) {
      s.deps = deps;
      effects.push(() => { s.cleanup?.(); s.cleanup = fn() || undefined; });
    }
  };
  const hooks = {
    useRef: (initial: unknown) => { const s = slot(); return s.value ??= { current: initial }; },
    useState: (initial: unknown) => {
      const s = slot(); if (!("value" in s)) s.value = initial;
      return [s.value, (value: unknown) => { s.value = value; }];
    },
    useCallback: (fn: unknown, deps: unknown[]) => {
      const s = slot(); if (changed(s.deps, deps)) { s.value = fn; s.deps = deps; } return s.value;
    },
    useEffect: effect, useLayoutEffect: effect,
    holdProgress, isPointerOutside, canContinueHold,
    React: { createElement: (type: unknown, props: object, ...children: unknown[]) => ({ type, props: { ...props, children } }) },
    performance: { now: () => now },
    requestAnimationFrame: (fn: (time: number) => void) => { frames.set(++nextFrame, fn); return nextFrame; },
    cancelAnimationFrame: (id: number) => { frames.delete(id); },
    window: { addEventListener() {}, removeEventListener() {} },
    document: { hidden: false, addEventListener() {}, removeEventListener() {} },
  };
  const Component = new Function(...Object.keys(hooks), compiled + "\nreturn HoldButton;")(...Object.values(hooks));
  let button: any;
  return {
    render(props: { chat: unknown; onConfirm: () => void; disabled?: boolean }) {
      cursor = 0; effects = [];
      button = Component({ disabled: false, ...props }).props.children[0];
      for (const run of effects) run();
    },
    event(name: string, values: object = {}) {
      button.props[name]?.({ button: 0, pointerId: 1, clientX: 50, clientY: 40,
        currentTarget: { setPointerCapture() {}, getBoundingClientRect: () => ({ left: 10, right: 110, top: 20, bottom: 60 }) },
        ...values });
    },
    advance(time: number) { now = time; const pending = [...frames.values()]; frames.clear(); for (const tick of pending) tick(now); },
  };
};

test("review-8: outside each edge cancels under pointer capture; lost capture also cancels", async () => {
  const bounds = { left: 10, right: 110, top: 20, bottom: 60 };
  for (const [x, y] of [[9, 40], [111, 40], [50, 19], [50, 61], [NaN, 40], [50, Infinity]])
    expect(isPointerOutside(x, y, bounds)).toBe(true);
  for (const [x, y] of [[10, 20], [110, 60], [50, 40]]) expect(isPointerOutside(x, y, bounds)).toBe(false);
  for (const [name, values] of [
    ["onPointerMove", { clientX: 9 }], ["onPointerMove", { clientX: 111 }],
    ["onPointerMove", { clientY: 19 }], ["onPointerMove", { clientY: 61 }], ["onLostPointerCapture", {}],
  ] as const) {
    const h = await harness(); let confirmed = 0;
    h.render({ chat: {}, onConfirm: () => { confirmed++; } });
    h.event("onPointerDown"); h.advance(600);
    h.event(name, values); h.advance(1200);
    expect(confirmed).toBe(0);
    // Moving back inside does not restart a cancelled hold.
    h.event("onPointerMove"); h.advance(1800);
    expect(confirmed).toBe(0);
    h.event("onPointerUp"); h.event("onPointerDown"); h.advance(3000);
    expect(confirmed).toBe(1);
  }
});

test("review-9: a running animation uses the latest callback for the same strategy", async () => {
  const h = await harness(); const chat = {};
  let oldCalls = 0; let newCalls = 0;
  h.render({ chat, onConfirm: () => { oldCalls++; } });
  h.event("onPointerDown"); h.advance(600);
  h.render({ chat, onConfirm: () => { newCalls++; } });
  h.advance(1200);
  expect(oldCalls).toBe(0);
  expect(newCalls).toBe(1);
});

test("review-9: changed strategy or disabled state cancels and requires a fresh hold", async () => {
  const first = {}; const second = {};
  expect(canContinueHold(first, first, false)).toBe(true);
  expect(canContinueHold(first, second, false)).toBe(false);
  expect(canContinueHold(first, first, true)).toBe(false);
  for (const changed of [{ chat: second, disabled: false }, { chat: first, disabled: true }]) {
    const h = await harness(); let confirmed = 0;
    const onConfirm = () => { confirmed++; };
    h.render({ chat: first, onConfirm });
    h.event("onPointerDown"); h.advance(600);
    h.render({ ...changed, onConfirm }); h.advance(1200);
    expect(confirmed).toBe(0);
    h.render({ chat: changed.chat, onConfirm }); h.advance(1800);
    expect(confirmed).toBe(0);
    h.event("onPointerUp"); h.event("onPointerDown"); h.advance(3000);
    expect(confirmed).toBe(1);
  }
});

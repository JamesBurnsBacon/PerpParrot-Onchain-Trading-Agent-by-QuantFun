import { expect, test } from "bun:test";
import { act } from "react";
import { createRoot } from "react-dom/client";
import PaintClient from "../app/parrot/paint/PaintClient";
import { paintDom } from "./helpers/paint-dom";

async function mounted(reduced: boolean, run: (h: ReturnType<typeof paintDom>, frames: Map<number, FrameRequestCallback>, cancelled: number[], unmount: () => Promise<void>) => Promise<void>) {
  const host = paintDom();
  host.motion.matches = reduced;
  const frames = new Map<number, FrameRequestCallback>(), cancelled: number[] = [];
  let serial = 0;
  const replacements = { window: host.window, document: host.document, IS_REACT_ACT_ENVIRONMENT: true,
    requestAnimationFrame: (fn: FrameRequestCallback) => { frames.set(++serial, fn); return serial; },
    cancelAnimationFrame: (id: number) => { cancelled.push(id); frames.delete(id); },
  };
  const descriptors = Object.fromEntries(Object.keys(replacements).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(replacements)) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  const root = createRoot(host.root as unknown as HTMLElement);
  let unmounted = false;
  const unmount = async () => { if (!unmounted) { await act(() => root.unmount()); unmounted = true; } };
  try {
    await act(() => root.render(<PaintClient />));
    await run(host, frames, cancelled, unmount);
  } finally {
    await unmount();
    for (const key of Object.keys(replacements)) {
      if (descriptors[key]) Object.defineProperty(globalThis, key, descriptors[key]!);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
}

test("unmount cancels the latest animation frame", async () => {
  await mounted(false, async (host, frames, cancelled, unmount) => {
    expect(frames.size).toBe(1);
    const [id, tick] = [...frames][0];
    frames.delete(id);
    await act(() => tick(0));
    const pending = [...frames.keys()][0];
    expect(pending).toBeGreaterThan(id);
    await unmount();
    expect(cancelled).toContain(pending);
    expect(frames.size).toBe(0);
    expect(host.listeners.size).toBe(0);
  });
});
test("reduced motion paints everything immediately without requesting a frame", async () => {
  await mounted(true, async (host, frames) => {
    expect(frames.size).toBe(0);
    expect(host.calls.filter(call => call === "fill" || call === "stroke")).toHaveLength(95 * 4);
  });
});
test("enabling reduced motion during replay finishes and cancels pending work", async () => {
  await mounted(false, async (host, frames) => {
    host.motion.matches = true;
    await act(() => { for (const listener of host.listeners) listener(); });
    expect(frames.size).toBe(0);
    expect(host.calls.filter(call => call === "fill" || call === "stroke")).toHaveLength(95 * 4);
  });
});

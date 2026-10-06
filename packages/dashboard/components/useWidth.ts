"use client";
import { useLayoutEffect, useRef, useState } from "react";

// Width of a container, for responsive SVG charts. The container must not grow with its
// content (min-w-0 in grids), or the observed width never shrinks.
export const useWidth = <T extends HTMLElement>(initial = 640) => {
  const ref = useRef<T>(null);
  const [width, setWidth] = useState(initial);
  useLayoutEffect(() => {
    if (!ref.current) return;
    const measure = (w: number) => setWidth(Math.max(240, Math.floor(w)));
    measure(ref.current.clientWidth); // before first paint
    const observer = new ResizeObserver(([entry]) => measure(entry.contentRect.width));
    observer.observe(ref.current);
    return () => observer.disconnect();
  }, []);
  return [ref, width] as const;
};

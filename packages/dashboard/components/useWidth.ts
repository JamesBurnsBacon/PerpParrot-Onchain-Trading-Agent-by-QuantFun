"use client";
import { useEffect, useRef, useState } from "react";

// Width of a container, for responsive SVG charts.
export const useWidth = <T extends HTMLElement>(initial = 640) => {
  const ref = useRef<T>(null);
  const [width, setWidth] = useState(initial);
  useEffect(() => {
    if (!ref.current) return;
    const observer = new ResizeObserver(([entry]) => setWidth(Math.max(240, Math.floor(entry.contentRect.width))));
    observer.observe(ref.current);
    return () => observer.disconnect();
  }, []);
  return [ref, width] as const;
};

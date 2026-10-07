"use client";
// A number that counts up once, the first time it scrolls into view. The server and the first
// client render show the final value; later changes (the page refreshes every minute) jump to it.
import { useEffect, useRef, useState } from "react";
import { gsap } from "gsap";

export function CountUp({ value, format }: { value: number; format: (n: number) => string }) {
  const node = useRef<HTMLSpanElement>(null);
  const [shown, setShown] = useState(value);
  const played = useRef(false);

  useEffect(() => {
    if (played.current) {
      setShown(value);
      return;
    }
    const el = node.current;
    if (!el || window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      setShown(value);
      return;
    }
    let tween: gsap.core.Tween | null = null;
    const observer = new IntersectionObserver(
      (entries) => {
        if (!entries[0]?.isIntersecting) return;
        observer.disconnect();
        played.current = true;
        const counter = { n: 0 };
        setShown(0);
        tween = gsap.to(counter, { n: value, duration: 1.4, ease: "power2.out", onUpdate: () => setShown(counter.n), onComplete: () => setShown(value) });
      },
      { threshold: 0.4 },
    );
    observer.observe(el);
    return () => {
      observer.disconnect();
      tween?.kill();
    };
  }, [value]);

  return <span ref={node}>{format(shown)}</span>;
}

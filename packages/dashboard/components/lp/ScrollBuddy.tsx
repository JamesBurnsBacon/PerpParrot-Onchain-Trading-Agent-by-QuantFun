"use client";
// A rainbow scroll-progress bar with a parrot riding its end, and a small feather burst on every click.
import { useEffect, useRef } from "react";
import { gsap } from "gsap";
import { Parrot } from "./ParrotSymbols";

const COLORS = ["#6cc04a", "#eac744", "#f29a2e", "#9683bf", "#639ec4"];

export function ScrollBuddy() {
  const fill = useRef<HTMLDivElement>(null);
  const rider = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let ticking = false;
    const update = () => {
      ticking = false;
      const room = document.documentElement.scrollHeight - window.innerHeight;
      const p = room > 0 ? Math.min(1, Math.max(0, window.scrollY / room)) : 0;
      if (fill.current) fill.current.style.width = `${p * 100}%`;
      if (rider.current) rider.current.style.left = `${Math.max(2, p * 100)}%`;
    };
    const onScroll = () => {
      if (ticking) return;
      ticking = true;
      requestAnimationFrame(update);
    };
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)");
    const onPointerDown = (e: PointerEvent) => {
      if (reduce.matches) return;
      for (let i = 0; i < 8; i++) {
        const f = document.createElement("i");
        f.className = "lp-pop-feather";
        f.style.left = `${e.clientX}px`;
        f.style.top = `${e.clientY}px`;
        f.style.background = COLORS[i % COLORS.length];
        document.body.appendChild(f);
        const a = (i / 8) * Math.PI * 2 + Math.random() * 0.5;
        const d = 40 + Math.random() * 50;
        gsap.to(f, { x: Math.cos(a) * d, y: Math.sin(a) * d + 30, rotation: Math.random() * 360, opacity: 0, duration: 0.9, ease: "power2.out", onComplete: () => f.remove() });
      }
    };
    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", update);
    window.addEventListener("pointerdown", onPointerDown);
    update();
    return () => {
      window.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", update);
      window.removeEventListener("pointerdown", onPointerDown);
    };
  }, []);

  return (
    <div className="lp-pbar" aria-hidden="true">
      <div className="lp-pbar-fill" ref={fill} />
      <div className="lp-pbar-rider" ref={rider}>
        <Parrot />
      </div>
    </div>
  );
}

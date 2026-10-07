"use client";
// A rainbow scroll-progress bar, and a small feather burst on every click.
import { useEffect, useRef } from "react";
import { gsap } from "gsap";

const COLORS = ["#6cc04a", "#eac744", "#f29a2e", "#9683bf", "#639ec4"];

export function ScrollBuddy() {
  const fill = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let frame = 0;
    // Click feathers are tracked so a route change cannot leave tweens or nodes behind.
    const feathers = new Set<{ node: HTMLElement; tween: gsap.core.Tween }>();
    const update = () => {
      frame = 0;
      const room = document.documentElement.scrollHeight - window.innerHeight;
      const p = room > 0 ? Math.min(1, Math.max(0, window.scrollY / room)) : 0;
      if (fill.current) fill.current.style.width = `${p * 100}%`;
    };
    const onScroll = () => {
      if (!frame) frame = requestAnimationFrame(update);
    };
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)");
    const onPointerDown = (e: PointerEvent) => {
      if (reduce.matches) return;
      for (let i = 0; i < 8; i++) {
        const node = document.createElement("i");
        node.className = "lp-pop-feather";
        node.style.left = `${e.clientX}px`;
        node.style.top = `${e.clientY}px`;
        node.style.background = COLORS[i % COLORS.length];
        document.body.appendChild(node);
        const a = (i / 8) * Math.PI * 2 + Math.random() * 0.5;
        const d = 40 + Math.random() * 50;
        const entry = { node, tween: null as unknown as gsap.core.Tween };
        entry.tween = gsap.to(node, {
          x: Math.cos(a) * d,
          y: Math.sin(a) * d + 30,
          rotation: Math.random() * 360,
          opacity: 0,
          duration: 0.9,
          ease: "power2.out",
          onComplete: () => {
            node.remove();
            feathers.delete(entry);
          },
        });
        feathers.add(entry);
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
      if (frame) cancelAnimationFrame(frame);
      feathers.forEach(({ node, tween }) => {
        tween.kill();
        node.remove();
      });
      feathers.clear();
    };
  }, []);

  return (
    <div className="lp-pbar" aria-hidden="true">
      <div className="lp-pbar-fill" ref={fill} />
    </div>
  );
}

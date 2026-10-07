"use client";
// Scroll reveals for the dashboard half: panels and tiles rise in, chart lines draw, run cells and
// bars grow. Everything plays once, when it first scrolls into view; reduced motion skips it all.
import type { RefObject } from "react";
import { gsap } from "gsap";
import { ScrollTrigger } from "gsap/ScrollTrigger";
import { useGSAP } from "@gsap/react";

gsap.registerPlugin(useGSAP, ScrollTrigger);

// `ready` flips once the first data has rendered, so the elements to animate exist.
export function useDashMotion(scope: RefObject<HTMLElement | null>, ready: boolean) {
  useGSAP(
    () => {
      if (!ready) return;
      const mm = gsap.matchMedia();
      mm.add("(prefers-reduced-motion: no-preference)", () => {
        const once = (trigger: Element, start = "top 90%") => ({ trigger, start, once: true });
        const all = <T extends Element>(selector: string) => gsap.utils.toArray<T>(selector);

        all<HTMLElement>(".lp-reveal").forEach((el) => gsap.from(el, { opacity: 0, y: 22, duration: 0.7, ease: "power3.out", scrollTrigger: once(el) }));

        all<SVGElement>(".lp-line").forEach((line, i) => {
          gsap.fromTo(
            line,
            { strokeDasharray: 1, strokeDashoffset: 1 },
            {
              strokeDashoffset: 0,
              duration: 1.8,
              delay: i * 0.12,
              ease: "power2.inOut",
              scrollTrigger: once(line.closest("svg") ?? line, "top 85%"),
              onComplete: () => {
                line.style.removeProperty("stroke-dasharray");
                line.style.removeProperty("stroke-dashoffset");
              },
            },
          );
        });
        all<SVGElement>(".lp-line-ref").forEach((line) => gsap.from(line, { opacity: 0, duration: 1.2, scrollTrigger: once(line.closest("svg") ?? line, "top 85%") }));

        all<HTMLElement>(".lp-cells").forEach((row) =>
          gsap.from(row.children, { scaleY: 0.15, opacity: 0, transformOrigin: "50% 100%", duration: 0.5, stagger: 0.012, ease: "back.out(2)", scrollTrigger: once(row) }),
        );

        all<HTMLElement>(".lp-grow").forEach((bar) => gsap.from(bar, { scaleX: 0, transformOrigin: "0 50%", duration: 0.9, ease: "power3.out", scrollTrigger: once(bar, "top 96%") }));
      });
      return () => mm.revert();
    },
    { scope, dependencies: [ready], revertOnUpdate: true },
  );
}

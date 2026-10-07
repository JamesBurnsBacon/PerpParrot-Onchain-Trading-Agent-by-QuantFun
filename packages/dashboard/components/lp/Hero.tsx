"use client";
// The landing half of the page: a pinned, scroll-scrubbed stage in three beats (see lp.css).
// Idle motion and the feather canvas run on gsap's ticker and stop when the stage is off screen,
// the tab is hidden, or the visitor prefers reduced motion (then one static final frame is shown).
import Image from "next/image";
import { useRef } from "react";
import { gsap } from "gsap";
import { ScrollTrigger } from "gsap/ScrollTrigger";
import { SplitText } from "gsap/SplitText";
import { useGSAP } from "@gsap/react";
import { Parrot } from "./ParrotSymbols";

gsap.registerPlugin(useGSAP, ScrollTrigger, SplitText);

const PALETTE = ["#6cc04a", "#3f9a3a", "#f29a2e", "#eac744", "#9683bf", "#639ec4"];
const BURST_COUNT = 72;

type Feather = { u: number; v: number; phase: number; lane: number; size: number; buy: boolean };
// Fixed, deterministic pool: 246 flowing feathers plus 72 burst feathers per frame.
const FEATHERS: Feather[] = Array.from({ length: 246 }, (_, i) => ({
  u: ((i * 73) % 251) / 251,
  v: ((i * 131) % 257) / 257,
  phase: i * 2.39996,
  lane: i % 6,
  size: 0.32 + (i % 9) * 0.07,
  buy: i % 3 !== 0,
}));

const FALLBACK_FEATHERS: [number, number, number][] = [
  [8, 22, -35], [17, 42, -26], [5, 72, -42], [27, 76, -22], [78, 22, 125], [89, 34, 140],
  [82, 72, 155], [67, 83, -25], [33, 34, -30], [71, 46, 145], [13, 57, -40], [93, 62, 140],
  [42, 85, -30], [56, 19, 125], [22, 18, -22], [72, 65, 135], [5, 88, -35], [90, 84, 135],
];

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, Number.isFinite(v) ? v : lo));
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const smooth = (v: number) => {
  const t = clamp(v, 0, 1);
  return t * t * (3 - 2 * t);
};
const wrap = (v: number) => ((v % 1) + 1) % 1;

export function Hero() {
  const root = useRef<HTMLElement>(null);

  useGSAP(
    () => {
      const el = root.current;
      if (!el) return;
      const field = el.querySelector<HTMLElement>(".lp-field");
      const canvas = el.querySelector<HTMLCanvasElement>("canvas");
      const ctaWrap = el.querySelector<HTMLElement>(".lp-cta-wrap");
      const stage = el.querySelector<HTMLElement>(".lp-stage");
      const ctx = canvas?.getContext("2d") ?? null;
      if (!field || !canvas || !ctaWrap || !stage || !ctx) return;
      const beats = Array.from(el.querySelectorAll<HTMLElement>(".lp-beat"));
      const featherShape = typeof Path2D !== "undefined" ? new Path2D("M-16 0 C-12-12 9-12 20-5 C14 9-7 14-16 0Z") : null;

      const state = { progress: 1 };
      const pointer = { x: -1000, y: -1000, active: false };
      let width = 1;
      let height = 1;
      let dpr = 1;
      let time = 0;
      let mode = -1;
      let enabled = false;
      let inView = false;
      let running = false;
      let intro: gsap.core.Timeline | null = null;
      let setters: Record<string, (v: number | string) => void> | null = null;

      // Beat 0..2 show their headline; beat 3 is the finale: the CTA replaces the last title.
      const showCopy = (progress: number) => {
        const next = progress < 0.34 ? 0 : progress < 0.68 ? 1 : progress < 0.86 ? 2 : 3;
        if (next === mode) return;
        mode = next;
        beats.forEach((b, i) => {
          b.hidden = i !== next;
        });
        ctaWrap.hidden = next !== 3;
        ctaWrap.style.display = next === 3 ? "flex" : "none";
      };

      const drawFeather = (x: number, y: number, angle: number, size: number, color: string) => {
        if (!featherShape || ![x, y, angle, size].every(Number.isFinite)) return;
        ctx.save();
        ctx.translate(x, y);
        ctx.rotate(angle);
        ctx.scale(size, size);
        ctx.fillStyle = color;
        ctx.fill(featherShape);
        ctx.beginPath();
        ctx.moveTo(-12, 2);
        ctx.quadraticCurveTo(0, 0, 16, -4);
        ctx.strokeStyle = "#fffcf59c";
        ctx.lineWidth = 1.1;
        ctx.stroke();
        ctx.restore();
      };

      const paint = () => {
        if (!featherShape || width < 1 || height < 1) return;
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctx.clearRect(0, 0, width, height);
        const p = clamp(state.progress, 0, 1);
        const order = smooth((p - 0.18) / 0.34);
        const cx = width * 0.5;
        const cy = height * (width > 1050 ? 0.57 : 0.54);
        const span = Math.min(width, height);
        const burst = smooth((p - 0.63) / 0.12);
        // Six lanes funnel into the mascot as the storm gets ordered.
        if (order > 0.03) {
          ctx.globalAlpha = order * 0.22;
          ctx.lineWidth = 1.5;
          for (let lane = 0; lane < 6; lane++) {
            const side = lane < 4 ? -1 : 1;
            ctx.strokeStyle = lane < 4 ? "#3f9a3a" : "#b66b13";
            ctx.beginPath();
            ctx.moveTo(cx + side * width * 0.65, cy + (lane - 2.5) * height * 0.075);
            ctx.bezierCurveTo(cx + side * width * 0.3, cy + (lane - 2.5) * height * 0.07, cx + side * span * 0.2, cy + span * 0.17, cx, cy);
            ctx.stroke();
          }
          ctx.globalAlpha = 1;
        }
        for (const f of FEATHERS) {
          const direction = f.buy ? 1 : -1;
          const travel = wrap(f.u + time * (0.035 + f.size * 0.028) * direction);
          const sx = travel * (width + 100) - 50;
          const sy = wrap(f.v - time * 0.041 * direction) * height + Math.sin(time * 1.3 + f.phase) * 18;
          // Green buys travel up/right, orange sells down/left in the storm.
          const q = wrap(f.u + time * 0.085);
          const remain = 1 - q;
          const side = f.lane < 4 ? -1 : 1;
          const laneOffset = (f.lane - 2.5) * height * 0.085;
          let lx = cx + side * width * 0.69 * remain;
          let ly = cy + laneOffset * remain + Math.sin(q * Math.PI) * span * 0.19;
          const curl = smooth((q - 0.64) / 0.36);
          lx += Math.sin(q * 13 + f.lane) * span * 0.09 * curl * remain;
          ly += Math.cos(q * 13 + f.lane) * span * 0.12 * curl * remain;
          let x = lerp(sx, lx, order);
          let y = lerp(sy, ly, order);
          if (pointer.active) {
            const dx = x - pointer.x;
            const dy = y - pointer.y;
            const dist = Math.max(1, Math.hypot(dx, dy));
            const force = Math.max(0, 1 - dist / 150) * 27;
            x += (dx / dist) * force;
            y += (dy / dist) * force;
          }
          const angle = lerp(f.buy ? -0.55 : 2.6, side < 0 ? -0.3 : 2.7, order) + Math.sin(time * 2 + f.phase) * (0.36 - 0.25 * order);
          const color = order < 0.5 ? (f.buy ? (f.lane === 0 ? PALETTE[3 + (f.lane % 3)] : PALETTE[f.lane % 2]) : PALETTE[2]) : PALETTE[f.lane];
          drawFeather(x, y, angle, f.size * (width < 600 ? 0.78 : 1) * lerp(1, 0.45 + remain * 0.7, order), color);
        }
        if (burst > 0) {
          const cycle = enabled ? (time % 3.6) / 3.6 : 0.28;
          // One short outward fan, then a quiet current; the 10-minute cadence is illustrative here.
          if (cycle < 0.58) {
            const age = cycle / 0.58;
            const radius = (0.11 + age * 0.66) * span;
            for (let i = 0; i < BURST_COUNT; i++) {
              const a = i * 2.39996;
              const spread = 0.7 + (i % 7) * 0.055;
              drawFeather(cx + Math.cos(a) * radius * spread, cy + Math.sin(a) * radius * 0.65 + age * age * 40, a + age * 3, 0.64 * (1 - age) * burst, PALETTE[i % 6]);
            }
          }
        }
        field.classList.add("lp-canvas-ready");
      };

      // Size the canvas only after layout; never feed 0 or NaN into the canvas.
      const size = () => {
        const rect = field.getBoundingClientRect();
        width = Math.max(1, Math.round(Number.isFinite(rect.width) ? rect.width : 1));
        height = Math.max(1, Math.round(Number.isFinite(rect.height) ? rect.height : 1));
        dpr = clamp(window.devicePixelRatio || 1, 1, 2);
        canvas.width = Math.max(1, Math.round(width * dpr));
        canvas.height = Math.max(1, Math.round(height * dpr));
        paint();
      };

      const pick = (selector: string) => el.querySelector<HTMLElement>(selector);
      const tick = (_time: number, deltaMs: number) => {
        if (!enabled || document.hidden || !inView) return;
        time += clamp(deltaMs / 1000, 0, 0.05);
        const p = state.progress;
        const pulse = 0.5 + 0.5 * Math.sin(time * 2.2);
        if (setters) {
          setters.floatY(Math.sin(time * 1.7) * 5);
          setters.floatR(Math.sin(time * 0.8) * 1.8);
          setters.haloScale(1 + pulse * 0.035);
          setters.haloTwoScale(1 + (0.5 + 0.5 * Math.sin(time * 2.2 - 1)) * 0.05);
          setters.haloR(time * (p > 0.65 ? 35 : 9));
          setters.birdR(-13 + Math.sin(time * 2) * 3);
          setters.hillX(Math.sin(time * 0.45) * 12);
          setters.hillR(-7 + Math.sin(time * 0.36) * 1.3);
          const b = (time % 3.6) / 3.6;
          setters.sweepScale(p > 0.65 ? 1 + b * 2 : 1.3 + pulse * 0.07);
          setters.ctaR(p > 0.86 ? Math.sin(time * 4) * Math.pow(Math.max(0, 1 - b * 4), 2) * 3 : 0);
        }
        paint();
      };

      const reconcile = () => {
        const should = enabled && inView && !document.hidden;
        if (should && !running) {
          gsap.ticker.add(tick);
          running = true;
        } else if (!should && running) {
          gsap.ticker.remove(tick);
          running = false;
        }
        if (intro) {
          if (should) intro.resume();
          else intro.pause();
        }
      };

      const staticFrame = () => {
        enabled = false;
        state.progress = 1;
        mode = -1;
        showCopy(1);
        el.classList.remove("lp-moving");
        reconcile();
        paint();
      };

      const onMove = (event: PointerEvent) => {
        const rect = field.getBoundingClientRect();
        pointer.x = event.clientX - rect.left;
        pointer.y = event.clientY - rect.top;
        pointer.active = true;
      };
      const onLeave = () => {
        pointer.active = false;
      };

      const observer = new IntersectionObserver((entries) => {
        inView = entries[0]?.isIntersecting ?? false;
        reconcile();
      });
      const resizer = new ResizeObserver(size);
      document.addEventListener("visibilitychange", reconcile);
      size();
      observer.observe(field);
      resizer.observe(field);

      const mm = gsap.matchMedia();
      mm.add({ reduce: "(prefers-reduced-motion: reduce)", motion: "(prefers-reduced-motion: no-preference)" }, (context) => {
        if (context.conditions?.reduce) {
          staticFrame();
          return;
        }
        enabled = true;
        state.progress = 0;
        time = 0;
        mode = -1;
        showCopy(0);
        el.classList.add("lp-moving");
        const split = SplitText.create(".lp-beat.first .lp-headline", { type: "words,chars", charsClass: "lp-char", aria: "auto" });
        intro = gsap.timeline().from(split.chars, { y: 50, scale: 0.35, rotation: -8, stagger: 0.045, duration: 0.8, ease: "back.out(1.65)" }, 0);
        const quick = (selector: string, prop: string, unit?: string) => gsap.quickSetter(pick(selector), prop, unit) as (v: number | string) => void;
        setters = {
          floatY: quick(".lp-mascot-float", "y", "px"),
          floatR: quick(".lp-mascot-float", "rotation", "deg"),
          haloScale: quick(".lp-halo.one", "scale"),
          haloTwoScale: quick(".lp-halo.two", "scale"),
          haloR: quick(".lp-halo.rainbow", "rotation", "deg"),
          birdR: quick(".lp-bird-badge", "rotation", "deg"),
          hillX: quick(".lp-hill.front", "x", "px"),
          hillR: quick(".lp-hill.front", "rotation", "deg"),
          sweepScale: quick(".lp-sweep", "scale"),
          ctaR: quick(".lp-cta", "rotation", "deg"),
        };
        gsap.set(".lp-mascot-pop", { scale: 0.36, rotation: -13 });
        gsap.set(".lp-cta", { scale: 0.92 });
        gsap
          .timeline({
            defaults: { ease: "none" },
            scrollTrigger: { trigger: el, pin: stage, start: "top top", end: "bottom bottom", pinSpacing: false, scrub: 0.7, invalidateOnRefresh: true },
            onUpdate: () => {
              showCopy(state.progress);
              if (!running) paint();
            },
          })
          .to(state, { progress: 1, duration: 3 }, 0)
          .to(".lp-mascot-pop", { scale: 1, rotation: 0, duration: 0.65, ease: "back.out(1.45)" }, 0.85)
          .to(".lp-mascot-pop", { scale: 1.06, duration: 0.4, ease: "back.out(1.5)" }, 2.04)
          .to(".lp-cta", { scale: 1, duration: 0.35, ease: "elastic.out(1,.5)" }, 2.58);
        field.addEventListener("pointermove", onMove, { passive: true });
        field.addEventListener("pointerleave", onLeave);
        reconcile();
        ScrollTrigger.refresh();
        return () => {
          enabled = false;
          reconcile();
          intro = null;
          setters = null;
          pointer.active = false;
          field.removeEventListener("pointermove", onMove);
          field.removeEventListener("pointerleave", onLeave);
          split.revert();
          // quickSetter writes need explicit restoration in addition to the context revert.
          el.querySelectorAll<HTMLElement>(".lp-mascot-float,.lp-halo,.lp-bird-badge,.lp-hill.front,.lp-sweep,.lp-cta").forEach((n) => n.style.removeProperty("transform"));
          staticFrame();
        };
      });

      return () => {
        mm.revert();
        enabled = false;
        reconcile();
        observer.disconnect();
        resizer.disconnect();
        document.removeEventListener("visibilitychange", reconcile);
      };
    },
    { scope: root },
  );

  return (
    <header className="lp-journey" id="top" ref={root}>
      <section className="lp-stage" aria-label="PerpParrot">
        {/* The animated headlines come and go; this heading is always in the document (and in the static frame). */}
        <h1 className="sr-only">PerpParrot</h1>
        <div className="lp-surface">
          <div className="lp-wordmark">
            <Parrot />
            PerpParrot
          </div>
          <div className="lp-field">
            <div className="lp-hill back" aria-hidden="true" />
            <div className="lp-hill front" aria-hidden="true" />
            <canvas aria-hidden="true" />
            <div className="lp-fallback" aria-hidden="true">
              {FALLBACK_FEATHERS.map(([x, y, a]) => (
                <i key={`${x}-${y}`} className="lp-feather" style={{ left: `${x}%`, top: `${y}%`, transform: `rotate(${a}deg)` }} />
              ))}
            </div>
            <div className="lp-copy">
              <div className="lp-beat first">
                <h2 className="lp-headline">
                  SO MANY <span className="lp-accent">TRADERS!</span>
                </h2>
              </div>
              <div className="lp-beat second" hidden>
                <h2 className="lp-headline">
                  WHO&apos;S FLYING <span className="lp-accent">BEST?</span>
                </h2>
              </div>
              <div className="lp-beat third" hidden>
                <h2 className="lp-headline">
                  FOLLOW THE <span className="lp-accent">FLOCK!</span>
                </h2>
              </div>
            </div>
            <div className="lp-nest">
              <div className="lp-mascot-pop">
                <div className="lp-mascot-float">
                  <div className="lp-halo one" aria-hidden="true" />
                  <div className="lp-halo two" aria-hidden="true" />
                  <div className="lp-sweep" aria-hidden="true" />
                  <div className="lp-halo rainbow" aria-hidden="true" />
                  <div className="lp-portrait">
                    <Image src="/lp/mascot.jpg" alt="Clay parrot mascot wearing a rainbow cap" width={524} height={528} priority />
                  </div>
                  <div className="lp-bird-badge" aria-hidden="true">
                    <Parrot />
                  </div>
                  <div className="lp-spark" aria-hidden="true" />
                  <i className="lp-twinkle t1" aria-hidden="true" style={{ left: "-34%", top: "6%" }} />
                  <i className="lp-twinkle t2" aria-hidden="true" style={{ left: "112%", top: "30%" }} />
                  <i className="lp-twinkle t3" aria-hidden="true" style={{ left: "-12%", top: "92%" }} />
                  <i className="lp-twinkle t4" aria-hidden="true" style={{ left: "96%", top: "88%" }} />
                </div>
              </div>
            </div>
            <div className="lp-cta-wrap" hidden style={{ display: "none" }}>
              <a className="lp-cta" href="#live">
                View live dashboard
                <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
                  <path d="M5 12h14m-6-6 6 6-6 6" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              </a>
            </div>
          </div>
        </div>
      </section>
    </header>
  );
}

import { useSceneIdentity, SceneSignature } from "../art/SceneIdentity";
import { useEffect, useRef, useState } from "react";
import { motion, useReducedMotion } from "motion/react";
import { SeedAtlas } from "./SeedAtlas";
import { useConductor } from "../art/ConductorProvider";
import { createFlightEngine } from "../art/flight-engine";
import {
  ArrowUpRight,
  Pause,
  Play,
  RotateCcw,
  Shuffle,
  Sparkles,
} from "lucide-react";

import "./flight-rig.css";

type Mode = "flow" | "flock" | "orbit";
export function FlightStage({
  onPlan,
  onMotionState,
}: {
  onPlan: () => void;
  onMotionState?: (paused: boolean) => void;
}) {
  const conductor = useConductor();
  const scene = useSceneIdentity();
  const { seed, mode, intensity, paused } = scene;
  const setSeed = (value: number | ((current: number) => number)) =>
    scene.dispatch({
      type: "seed",
      value: typeof value === "function" ? value(seed) : value,
    });
  const setMode = (value: Mode) => scene.dispatch({ type: "mode", value });
  const setIntensity = (value: number) =>
    scene.dispatch({ type: "intensity", value });
  const setPaused = scene.setPaused;
  const canvas = useRef<HTMLCanvasElement>(null),
    stage = useRef<HTMLDivElement>(null),
    bird = useRef<HTMLImageElement>(null),
    rig = useRef<HTMLDivElement>(null),
    leftWing = useRef<HTMLImageElement>(null),
    rightWing = useRef<HTMLImageElement>(null),
    cueStart = useRef(-100),
    cueRunning = useRef(false),
    currentPhase = useRef(0),
    feedRef = useRef<() => void>(() => {});
  const reduced = useReducedMotion();
  const [cueActive, setCueActive] = useState(false),
    [feeds, setFeeds] = useState(0);
  const accentRef = useRef(scene.accent);
  accentRef.current = scene.accent;
  const pausedRef = useRef(paused),
    intensityRef = useRef(intensity),
    syncRef = useRef<() => void>(() => {});
  useEffect(() => {
    syncRef.current();
  }, [scene.accent]);
  useEffect(() => {
    pausedRef.current = paused;
    intensityRef.current = intensity;
    syncRef.current();
    onMotionState?.(paused || !!reduced);
  }, [paused, intensity, reduced, onMotionState]);
  useEffect(() => {
    const element = canvas.current,
      area = stage.current;
    if (!element || !area) return;
    const ctx = element.getContext("2d");
    if (!ctx) return;
    let visible = true,
      accumulator = 0,
      tiltX = 0,
      tiltY = 0,
      presence = 0,
      disposed = false;
    const engine = createFlightEngine({ seed, mode });
    const particles = engine.particles;
    const pointer = { x: 0.5, y: 0.5, active: false };
    const advance = () =>
      engine.advance({ intensity: intensityRef.current, pointer });
    const paint = () => {
      const w = element.clientWidth,
        h = element.clientHeight,
        dpr = Math.min(devicePixelRatio, 2);
      if (
        element.width !== Math.round(w * dpr) ||
        element.height !== Math.round(h * dpr)
      ) {
        element.width = Math.round(w * dpr);
        element.height = Math.round(h * dpr);
      }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, w, h);
      for (const [index, p] of particles.entries()) {
        ctx.beginPath();
        for (let i = 0; i < p.count; i++) {
          const point = p.history[(p.cursor - p.count + i + 26) % 26];
          if (i) ctx.lineTo(point.x * w, point.y * h);
          else ctx.moveTo(point.x * w, point.y * h);
        }
        ctx.strokeStyle =
          scene.demo && index % 5 === 0
            ? accentRef.current
            : scene.palette === "ultraviolet"
              ? ["#ad91ff", "#7ffff2", "#f3ff86", "#ff81d8", "#8eb6ff"][
                  index % 5
                ]
              : p.color;
        ctx.globalAlpha = 0.2 + intensityRef.current * 0.004;
        ctx.lineWidth =
          p.size * (0.85 + Math.sin(engine.tick * 0.012 + p.size) * 0.25);
        ctx.lineCap = "round";
        ctx.stroke();
      }
      const burstAge = (currentPhase.current - cueStart.current) / 1.5;
      if (cueRunning.current && burstAge >= 0 && burstAge < 1) {
        const radius = 18 + burstAge * 115;
        for (let i = 0; i < 24; i++) {
          const angle = (i * Math.PI) / 12 + seed * 0.017;
          const x = 0.37 * w + Math.cos(angle) * radius,
            y = 0.47 * h + Math.sin(angle) * radius * 0.72;
          ctx.strokeStyle = i % 3 === 0 ? "#ff927e" : "#edff70";
          ctx.globalAlpha = (1 - burstAge) * 0.58;
          ctx.lineWidth = 1.4;
          ctx.beginPath();
          ctx.moveTo(x, y);
          ctx.lineTo(x + Math.cos(angle) * 12, y + Math.sin(angle) * 9);
          ctx.lineTo(
            x + Math.cos(angle + 0.4) * 7,
            y + Math.sin(angle + 0.4) * 7,
          );
          ctx.stroke();
        }
      }
      ctx.globalAlpha = 1;
    };
    feedRef.current = () => {
      particles.forEach((particle, index) => {
        if (index % 3 !== 0) return;
        const angle = index * 2.399963 + ((seed % 360) * Math.PI) / 180;
        particle.x = 0.37 + Math.cos(angle) * 0.015;
        particle.y = 0.47 + Math.sin(angle) * 0.015;
        particle.vx = Math.cos(angle) * 0.009;
        particle.vy = Math.sin(angle) * 0.009;
        particle.count = 0;
        particle.cursor = 0;
        particle.color = index % 2 === 0 ? "#edff70" : "#ff927e";
      });
      if (pausedRef.current || reduced) {
        for (let i = 0; i < 18; i++) advance();
        paint();
      }
    };
    const running = () =>
      !pausedRef.current &&
      !reduced &&
      visible &&
      !document.hidden &&
      !disposed;
    const draw = (clock: { delta: number; phase: number }) => {
      if (!running()) return;
      const elapsed = clock.delta;
      accumulator += elapsed;
      let steps = 0;
      while (accumulator >= 16.667 && steps < 3) {
        advance();
        accumulator -= 16.667;
        steps++;
      }
      paint();
      const damping = 1 - Math.pow(0.955, elapsed / 16.667);
      tiltX += ((pointer.active ? (pointer.x - 0.5) * 7 : 0) - tiltX) * damping;
      tiltY +=
        ((pointer.active ? (pointer.y - 0.5) * -5 : 0) - tiltY) * damping;
      currentPhase.current = clock.phase;
      presence += ((pointer.active ? 1 : 0) - presence) * damping;
      const takeoffTime = clock.phase - cueStart.current;
      if (cueRunning.current && takeoffTime > 2.8) {
        cueRunning.current = false;
        setCueActive(false);
      }
      const takeoff =
        takeoffTime >= 0 && takeoffTime <= 2.8
          ? Math.sin((takeoffTime / 2.8) * Math.PI)
          : 0;
      const progress = Math.max(
        0,
        Math.min(
          1,
          -area.getBoundingClientRect().top / (area.clientHeight * 0.9),
        ),
      );
      const beat = Math.sin(clock.phase * 2.55),
        delayedBeat = Math.sin(clock.phase * 2.55 - 0.52),
        amplitude = 4.8 + takeoff * 5.5 + presence * 1.8;
      if (rig.current) {
        const floating =
          Math.sin(clock.phase * 1.24) * 8 + Math.sin(clock.phase * 0.61) * 3;
        const bank = Math.sin(clock.phase * 0.91) * 1.8;
        rig.current.style.transform = `perspective(1100px) translate3d(${presence * 7 + progress * 26}px,${floating - takeoff * 31 - presence * 9 - progress * 25}px,0) rotateX(${tiltY}deg) rotateY(${tiltX}deg) rotateZ(${bank - takeoff * 4.5 - progress * 6}deg) scale(${1.004 + takeoff * 0.028 + presence * 0.009 - progress * 0.035})`;
        rig.current.style.setProperty("--wing-beat", String(beat));
      }
      if (rightWing.current)
        rightWing.current.style.transform = `rotateZ(${-beat * amplitude}deg) rotateY(${beat * 4}deg) scaleY(${1 + beat * 0.024})`;
      if (leftWing.current)
        leftWing.current.style.transform = `rotateZ(${delayedBeat * (amplitude * 0.8)}deg) rotateY(${-delayedBeat * 3}deg) scaleY(${1 - delayedBeat * 0.018})`;
      area.style.setProperty("--flight-progress", String(progress));
    };
    const subscription = conductor.subscribe(draw, { active: false });
    const sync = () => {
      area.dataset.motionActive = String(running());
      accumulator = 0;
      subscription.setActive(running());
    };
    syncRef.current = () => {
      paint();
      sync();
    };
    const move = (event: PointerEvent) => {
      const r = area.getBoundingClientRect();
      pointer.x = (event.clientX - r.left) / r.width;
      pointer.y = (event.clientY - r.top) / r.height;
      pointer.active = true;
    };
    const leave = () => (pointer.active = false);
    for (let i = 0; i < 38; i++) advance();
    paint();
    if (reduced) {
      if (rig.current) rig.current.style.transform = "none";
      if (leftWing.current) leftWing.current.style.transform = "none";
      if (rightWing.current) rightWing.current.style.transform = "none";
    }
    const observer = new IntersectionObserver(
      (entries) => {
        visible = entries[0].isIntersecting;
        sync();
      },
      { threshold: 0.05 },
    );
    observer.observe(area);
    window.addEventListener("resize", paint);
    document.addEventListener("visibilitychange", sync);
    area.addEventListener("pointermove", move);
    area.addEventListener("pointerleave", leave);
    sync();
    return () => {
      disposed = true;
      feedRef.current = () => {};
      subscription.unsubscribe();
      observer.disconnect();
      window.removeEventListener("resize", paint);
      document.removeEventListener("visibilitychange", sync);
      area.removeEventListener("pointermove", move);
      area.removeEventListener("pointerleave", leave);
    };
  }, [mode, seed, reduced, conductor, scene.palette, scene.epoch]);
  useEffect(() => {
    if (!scene.pulse.id || paused || reduced) return;
    const bounds = stage.current?.getBoundingClientRect();
    if (!bounds || bounds.bottom < 0 || bounds.top > window.innerHeight) return;
    cueStart.current = scene.pulse.phase;
    cueRunning.current = true;
    setCueActive(true);
    setFeeds((value) => value + 1);
    feedRef.current();
  }, [scene.pulse.id]);
  return (
    <section
      className="flight-section parrotverse"
      aria-labelledby="flight-title"
    >
      <div className="flight-topline">
        <span>PERPPARROT / PARROTVERSE</span>
        <span>THE SIGNAL PLAYGROUND</span>
      </div>
      <div className="flight-hero">
        <motion.div
          className="hero-copy"
          initial={false}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.8 }}
        >
          <div className="overline">
            <span className="status-dot" /> BIG INSTINCTS. YOUR OWN FORMATION.
          </div>
          <h1 id="flight-title">
            Find your
            <br />
            <em>
              flock<span className="flock-period">.</span>
            </em>
          </h1>
          <p>
            Pick your voices.
            <br />
            Mix their conviction into one clear target.
            <br />
            You’re in charge of the flock.
          </p>
          <div className="hero-actions">
            <a className="button yellow" href="#workspace">
              Explore the workspace <ArrowUpRight size={17} />
            </a>
            <button className="text-button" onClick={onPlan}>
              Preview a flight plan <ArrowUpRight size={15} />
            </button>
          </div>
          <div className="hero-footnote">
            HYPERLIQUID STRATEGY CONCEPT
            <br />
            Synthetic data. No live orders.
          </div>
        </motion.div>
        <div className="flight-art" ref={stage}>
          <div className="parrotverse-portal" aria-hidden="true">
            <div className="portal-perimeter" />
            <span className="portal-wordmark">P / P</span>
            <span className="portal-coordinates">
              ORIGINAL CHARACTER
              <br />
              INFINITE PATTERNS
            </span>
          </div>
          <div className="flight-pass" aria-hidden="true">
            <div className="pass-mark">
              PP<span>✳</span>
            </div>
            <div>
              <span>YOUR FLIGHT PASS</span>
              <strong>SEED {String(seed).padStart(3, "0")}</strong>
              <small>CREATIVE PLAYGROUND / NO LIVE ORDERS</small>
            </div>
            <div className="pass-perforation" />
          </div>
          <svg
            className="flight-notation"
            viewBox="0 0 700 620"
            aria-hidden="true"
          >
            <g>
              {Array.from({ length: 5 }, (_, i) => (
                <path
                  key={i}
                  d={`M${35 + i * 11} ${388 + i * 19} C${110 + i * 12} ${300 + i * 15},${195 + i * 19} ${420 - i * 13},${320 + i * 10} ${255 + i * 17}`}
                />
              ))}
            </g>
            <text x="46" y="520" transform="rotate(-8 46 520)">
              wild by design.
            </text>
          </svg>
          <canvas ref={canvas} aria-hidden="true" />
          <div className="orbit-line" />
          <div className="parrot-rig" ref={rig}>
            <img
              ref={leftWing}
              className="rig-wing rig-wing-left"
              src="./assets/parrot-flight.png"
              alt=""
              aria-hidden="true"
              width="1536"
              height="1024"
            />
            <img
              ref={rightWing}
              className="rig-wing rig-wing-right"
              src="./assets/parrot-flight.png"
              alt=""
              aria-hidden="true"
              width="1536"
              height="1024"
            />
            <img
              ref={bird}
              className="rig-body"
              src="./assets/parrot-flight.png"
              alt="Original golden and titanium parrot, composed into independently articulated wings and body"
              width="1536"
              height="1024"
            />
          </div>
        </div>
        <div className="flight-caption">
          <span>MEET YOUR WINGMAN</span>
          <strong>
            A little wild.
            <br />
            All yours.
          </strong>
          <button
            className="cue-takeoff"
            aria-label="Feed the flock"
            title="Release decorative ribbons and cue a takeoff. Portfolio values stay unchanged."
            disabled={paused}
            onClick={() => {
              cueStart.current = currentPhase.current;
              cueRunning.current = !reduced;
              setCueActive(!reduced);
              setFeeds((value) => value + 1);
              feedRef.current();
            }}
          >
            <Sparkles size={15} /> {cueActive ? "Flock fed!" : "Feed the flock"}{" "}
            <ArrowUpRight size={12} />
          </button>
          <span className="feed-caption" aria-live="polite">
            {feeds
              ? `${feeds} creative ${feeds === 1 ? "burst" : "bursts"}. Preview unchanged.`
              : "Art playground. Your preview stays put."}
          </span>
        </div>
        <div className="flight-scene-footer">
          <SceneSignature />
          <a href="#signalverse">
            Enter the signalverse <ArrowUpRight size={16} />
          </a>
        </div>
      </div>
      <div className="flight-bottom">
        <div className="flight-memory">
          <span className="tiny">FLIGHT MEMORY</span>
          <span>
            YOUR FLOCK.
            <br />
            YOUR RULES.
          </span>
        </div>
        <div className="flight-controls">
          <div
            className="mode-controls"
            role="group"
            aria-label="Decorative flight mode"
          >
            {(["flow", "flock", "orbit"] as Mode[]).map((m) => (
              <button
                key={m}
                aria-pressed={mode === m}
                onClick={() => setMode(m)}
              >
                <span>
                  {m === "flow"
                    ? "Allegro"
                    : m === "flock"
                      ? "Ensemble"
                      : "Adagio"}
                </span>
                <small>
                  {m === "flow" ? "Flow" : m === "flock" ? "Flock" : "Orbit"}
                </small>
              </button>
            ))}
          </div>
          <button
            className="seed-control"
            onClick={() => setSeed((s) => s + 1)}
            aria-label="Generate next reproducible seed"
          >
            <Shuffle size={13} /> Seed {seed}
          </button>
          <button
            className="icon-button"
            aria-label="Reset shared artwork: seed 47, Flow and Parrot, Solar palette, 55 percent intensity"
            onClick={() => {
              scene.dispatch({ type: "reset" });
            }}
          >
            <RotateCcw size={14} />
          </button>
          <label className="intensity">
            Tempo / intensity <span>{intensity}%</span>
            <input
              aria-label="Flight intensity"
              type="range"
              min="10"
              max="100"
              value={intensity}
              onChange={(e) => setIntensity(Number(e.target.value))}
            />
          </label>
          <button
            className="pause-button"
            disabled={!!reduced}
            aria-pressed={paused || !!reduced}
            onClick={() => setPaused(!paused)}
          >
            {paused || reduced ? <Play size={13} /> : <Pause size={13} />}{" "}
            {reduced ? "Reduced motion" : paused ? "Resume" : "Pause"}
          </button>
        </div>
        <div className="tiny art-boundary">
          GENERATIVE IDENTITY ART
          <br />
          NOT A TRADING SIMULATION
        </div>
      </div>
      <SeedAtlas
        seed={seed}
        mode={mode}
        intensity={intensity}
        onSelect={setSeed}
      />
    </section>
  );
}

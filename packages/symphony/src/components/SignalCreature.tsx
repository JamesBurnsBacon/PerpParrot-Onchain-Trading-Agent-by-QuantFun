import { useSceneIdentity, SceneSignature } from "../art/SceneIdentity";
import { shapeForMode, modeForShape } from "../art/scene-state";
import { useEffect, useRef, useState } from "react";
import { useReducedMotion } from "motion/react";
import { ArrowUpRight, Shuffle, Pause, Play, RefreshCw } from "lucide-react";
import { useConductor } from "../art/ConductorProvider";
import { createParrotMorph } from "../art/parrot-morph";
import type {
  MorphShape,
  MorphPalette,
  ParrotMorph,
} from "../art/parrot-morph";
import {
  createPointRenderer,
  createCanvasPointRenderer,
} from "../art/point-renderer";
import type { PointRenderer } from "../art/point-renderer";
import "./signal-creature.css";
import "./cinematic-creature.css";
export function SignalCreature({ paused }: { paused: boolean }) {
  const conductor = useConductor(),
    reduced = useReducedMotion();
  const identity = useSceneIdentity();
  const { seed, palette } = identity,
    shape = shapeForMode(identity.mode),
    still = false;
  const setShape = (value: MorphShape) =>
    identity.dispatch({ type: "mode", value: modeForShape(value) });
  const setPalette = (value: MorphPalette) =>
    identity.dispatch({ type: "palette", value });
  const setSeed = (update: (current: number) => number) =>
    identity.dispatch({ type: "seed", value: update(seed) });
  const [rendererKind, setRendererKind] = useState(""),
    [reaction, setReaction] = useState("A little chaos. A little character.");
  const scene = useRef<HTMLElement>(null),
    camera = useRef(0.5),
    host = useRef<HTMLDivElement>(null),
    canvas = useRef<HTMLCanvasElement>(null),
    fallback = useRef<HTMLCanvasElement>(null),
    engine = useRef<ParrotMorph | null>(null),
    paint = useRef(() => {}),
    shapeRef = useRef(shape),
    paletteRef = useRef(palette),
    active = useRef(false),
    sync = useRef(() => {}),
    framePhase = useRef(0),
    gates = useRef({ paused, still, reduced: !!reduced }),
    intensityRef = useRef(identity.intensity);
  intensityRef.current = identity.intensity;
  shapeRef.current = shape;
  paletteRef.current = palette;
  gates.current = { paused, still, reduced: !!reduced };
  useEffect(() => {
    sync.current();
    if (paused || still || reduced) paint.current();
  }, [paused, still, reduced]);
  useEffect(() => {
    const node = host.current,
      glCanvas = canvas.current,
      canvasFallback = fallback.current;
    if (!node || !glCanvas || !canvasFallback) return;
    const art = createParrotMorph(seed, 3200);
    art.setShape(shapeRef.current);
    art.setPalette(paletteRef.current);
    art.positions.set(art.targets);
    engine.current = art;
    let renderer: PointRenderer = createPointRenderer(glCanvas, canvasFallback);
    setRendererKind(renderer.kind);
    let pointer = { x: 0, y: 0, active: false },
      target = { x: 0, y: 0, active: false },
      dpr = 1;
    const draw = () =>
      renderer.draw(art, {
        phase: framePhase.current,
        x: pointer.x,
        y: pointer.y,
        width: glCanvas.width,
        height: glCanvas.height,
        dpr,
        camera: camera.current,
      });
    paint.current = draw;
    const resize = () => {
      const rect = node.getBoundingClientRect();
      dpr = Math.min(devicePixelRatio || 1, 1.75);
      glCanvas.width = canvasFallback.width = Math.max(
        1,
        Math.round(rect.width * dpr),
      );
      glCanvas.height = canvasFallback.height = Math.max(
        1,
        Math.round(rect.height * dpr),
      );
      draw();
    };
    const subscription = conductor.subscribe(
      (frame) => {
        framePhase.current = frame.phase;
        const bounds = scene.current?.getBoundingClientRect();
        if (bounds) {
          const targetCamera = Math.max(
            0,
            Math.min(
              1,
              (frame.viewport.height - bounds.top) /
                (frame.viewport.height + bounds.height),
            ),
          );
          camera.current +=
            (targetCamera - camera.current) *
            (1 - Math.exp(-frame.delta / 220));
          scene.current?.style.setProperty(
            "--scene-progress",
            String(camera.current),
          );
          scene.current?.style.setProperty(
            "--scene-y",
            `${(camera.current - 0.5) * -85}px`,
          );
        }
        const damping = 1 - Math.exp(-frame.delta / 150);
        pointer.x += (target.x - pointer.x) * damping;
        pointer.y += (target.y - pointer.y) * damping;
        pointer.active = target.active;
        art.advance(frame.delta * (0.6 + intensityRef.current / 100), pointer);
        draw();
      },
      { active: false },
    );
    const reconcile = () =>
      subscription.setActive(
        active.current &&
          !gates.current.paused &&
          !gates.current.still &&
          !gates.current.reduced,
      );
    sync.current = reconcile;
    const observer = new IntersectionObserver(
      (entries) => {
        active.current = entries[0].isIntersecting;
        reconcile();
      },
      { threshold: 0.1 },
    );
    observer.observe(node);
    const resizeObserver = new ResizeObserver(resize);
    resizeObserver.observe(node);
    const move = (event: PointerEvent) => {
      const r = node.getBoundingClientRect();
      target = {
        x:
          ((event.clientX - r.left - r.width / 2) /
            Math.min(r.width, r.height)) *
          2.7,
        y:
          (-(event.clientY - r.top - r.height / 2) /
            Math.min(r.width, r.height)) *
          2.7,
        active: true,
      };
    };
    const leave = () => {
      target = { x: 0, y: 0, active: false };
    };
    const lost = (event: Event) => {
      event.preventDefault();
      renderer.dispose();
      renderer = createCanvasPointRenderer(glCanvas, canvasFallback);
      setRendererKind("Canvas");
      draw();
    };
    const restored = () => {
      renderer.dispose();
      renderer = createPointRenderer(glCanvas, canvasFallback);
      setRendererKind(renderer.kind);
      draw();
    };
    node.addEventListener("pointermove", move, { passive: true });
    node.addEventListener("pointerleave", leave);
    node.addEventListener("pointerup", leave);
    glCanvas.addEventListener("webglcontextlost", lost);
    glCanvas.addEventListener("webglcontextrestored", restored);
    resize();
    return () => {
      subscription.unsubscribe();
      observer.disconnect();
      resizeObserver.disconnect();
      node.removeEventListener("pointermove", move);
      node.removeEventListener("pointerleave", leave);
      node.removeEventListener("pointerup", leave);
      glCanvas.removeEventListener("webglcontextlost", lost);
      glCanvas.removeEventListener("webglcontextrestored", restored);
      renderer.dispose();
      engine.current = null;
      paint.current = () => {};
      sync.current = () => {};
      active.current = false;
    };
  }, [seed, conductor, identity.epoch]);
  useEffect(() => {
    engine.current?.setShape(shape);
    if (paused || reduced)
      engine.current?.positions.set(engine.current.targets);
    paint.current();
  }, [shape]);
  useEffect(() => {
    const art = engine.current;
    if (!art) return;
    art.setPalette(palette);
    if (identity.demo) {
      const rgb = parseInt(identity.accent.slice(1), 16),
        channels = [
          (rgb >> 16) / 255,
          ((rgb >> 8) & 255) / 255,
          (rgb & 255) / 255,
        ];
      const mix =
        0.28 +
        (identity.activeIds.length / Math.max(1, identity.sources.length)) *
          0.12;
      for (let i = 0; i < art.count; i++)
        for (let axis = 0; axis < 3; axis++)
          art.colors[i * 3 + axis] =
            art.colors[i * 3 + axis] * (1 - mix) + channels[axis] * mix;
    }
    paint.current();
  }, [
    palette,
    identity.accent,
    identity.demo,
    identity.activeIds.join(","),
    seed,
    identity.epoch,
  ]);
  useEffect(() => {
    if (!identity.pulse.id || !active.current || paused || reduced) return;
    engine.current?.burst();
    setReaction("Shared flight pulse. Your portfolio stays unchanged.");
  }, [identity.pulse.id]);
  const changeShape = (next: MorphShape) => {
    setShape(next);
    engine.current?.setShape(next);
    if (paused || still || reduced)
      engine.current?.positions.set(engine.current.targets);
    paint.current();
    setReaction(
      next === "parrot"
        ? "Your creature. Back in character."
        : next === "plumage"
          ? "Same flock. A different silhouette."
          : "A tiny universe, in your hands.",
    );
  };
  const changePalette = (next: MorphPalette) => {
    setPalette(next);
    engine.current?.setPalette(next);
    paint.current();
  };
  return (
    <section
      id="signalverse"
      ref={scene}
      className="signal-creature cinematic-creature"
      aria-labelledby="creature-title"
    >
      <svg
        className="signalverse-stars"
        viewBox="0 0 1600 1000"
        preserveAspectRatio="xMidYMid slice"
        aria-hidden="true"
      >
        <defs>
          <linearGradient id="plume-contour" x1="0" y1="1" x2="1" y2="0">
            <stop stopColor="#ffb46c" stopOpacity=".02" />
            <stop offset=".5" stopColor="#ffd97b" stopOpacity=".36" />
            <stop offset="1" stopColor="#79d5f4" stopOpacity=".02" />
          </linearGradient>
        </defs>
        {Array.from({ length: 9 }, (_, i) => (
          <path
            key={i}
            d={`M${640 + i * 19} 1120 C${140 + i * 83} ${500 - i * 15},${940 + i * 32} ${130 + i * 22},${1500 + i * 35} ${-100 + i * 39}`}
            fill="none"
            stroke="url(#plume-contour)"
            strokeWidth={i % 3 === 0 ? 2 : 0.7}
          />
        ))}
      </svg>
      <div className="signalverse-floor" aria-hidden="true" />
      <div className="creature-copy">
        <span className="creature-eyebrow">
          Your signal, with a life of its own.
        </span>
        <h2 id="creature-title">
          Instinct,
          <br />
          <span>in formation.</span>
        </h2>
        <p>
          One character. A thousand possible formations.
          <br />
          Ruffle its feathers. Then give your conviction a shape.
        </p>
        <a href="#score-title" className="creature-cta">
          Compose your five voices <ArrowUpRight size={20} />
        </a>
        <div className="creature-sticker" aria-hidden="true">
          LESS ECHO.
          <br />
          <b>MORE INSTINCT.</b>
          <span>✳</span>
        </div>
      </div>
      <div className="creature-lab">
        <div
          className="creature-stage"
          ref={host}
          role="img"
          aria-label={`Original ${shape} particle sculpture in ${palette} colors. Decorative artwork, not market activity.`}
        >
          <canvas ref={canvas} aria-hidden="true" />
          <canvas ref={fallback} aria-hidden="true" />
          <div className="creature-stage-top">
            <span>PARROTVERSE</span>
            <span>SEED {seed.toString().padStart(3, "0")}</span>
          </div>

          <div className="creature-stage-bottom">
            <span>{rendererKind} / 3,200 POINTS</span>
            <span>MOVE TO RUFFLE ↗</span>
          </div>
        </div>
        <div className="creature-controls">
          <div role="group" aria-label="Particle sculpture shape">
            {(["parrot", "plumage", "orbit"] as const).map((mode) => (
              <button
                key={mode}
                aria-pressed={shape === mode}
                onClick={() => changeShape(mode)}
              >
                {mode}
              </button>
            ))}
          </div>
          <div role="group" aria-label="Artwork color palette">
            {(["solar", "ultraviolet"] as const).map((color) => (
              <button
                className={"palette-" + color}
                key={color}
                aria-label={`${color} artwork palette`}
                aria-pressed={palette === color}
                onClick={() => changePalette(color)}
              >
                <span />
                {color}
              </button>
            ))}
          </div>
          <div className="creature-action-row">
            <button
              className="scatter-button"
              disabled={paused || still || !!reduced}
              onClick={() => {
                identity.dispatch({ type: "pulse", phase: framePhase.current });
              }}
            >
              <Shuffle size={16} />
              Scatter & reform
            </button>
            <button
              aria-label="Generate new shared artwork seed"
              onClick={() => {
                setSeed((value) => value + 1);
                setReaction("A new seed. Still unmistakably yours.");
              }}
            >
              <RefreshCw size={16} />
            </button>
            <button
              disabled={!!reduced}
              aria-label={paused ? "Resume all motion" : "Pause all motion"}
              onClick={() => identity.setPaused(!paused)}
            >
              {paused ? <Play size={16} /> : <Pause size={16} />}
            </button>
          </div>
          <p role="status">
            {paused
              ? "Global motion is paused."
              : reduced
                ? "Still artwork follows your reduced-motion preference."
                : reaction}
          </p>
          <SceneSignature />
          <span className="creature-boundary">
            Original interactive artwork. Visual play changes no trading
            targets.
          </span>
        </div>
      </div>
    </section>
  );
}

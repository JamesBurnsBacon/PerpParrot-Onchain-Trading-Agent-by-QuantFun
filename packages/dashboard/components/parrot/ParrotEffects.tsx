import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { ParrotSfx } from "../../lib/parrot-sfx";
import { flashTimeline, motionAllowed, nextCombo, particleAlive, particleBudget, type EffectEvent } from "../../lib/wallet-board";

type Celebration = { id: number; kind: "strategy" | "lock" | "clamp"; combo: number; animated: boolean };
type Effects = { calm: boolean; sound: boolean; reduced: boolean; quiet: boolean; sfx: ParrotSfx;
  toggleCalm: () => void; toggleSound: () => void; trigger: (kind: EffectEvent, count?: number, removed?: number, clamped?: boolean) => void; celebration: Celebration | null };
const Context = createContext<Effects | null>(null);
export const useParrotEffects = () => useContext(Context)!;
export function ParrotEffectsProvider({ children }: { children: ReactNode }) {
  const [sfx] = useState(() => new ParrotSfx());
  const [calm, setCalm] = useState(false), [sound, setSound] = useState(true), [reduced, setReduced] = useState(false);
  const [celebration, setCelebration] = useState<Celebration | null>(null);
  const combo = useRef({ count: 0, at: -Infinity });
  const flashes = useRef<number[]>([]), serial = useRef(0);
  const expire = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const quiet = !motionAllowed(calm, reduced);
  useEffect(() => {
    try { setCalm(localStorage.getItem("parrot-calm") === "true"); setSound(localStorage.getItem("parrot-sound") !== "false"); } catch {}
    const media = matchMedia("(prefers-reduced-motion: reduce)");
    const update = () => setReduced(media.matches); update(); media.addEventListener("change", update);
    const hide = () => { if (document.hidden) { sfx.cancel(); setCelebration(null); clearTimeout(expire.current); } };
    document.addEventListener("visibilitychange", hide);
    return () => { media.removeEventListener("change", update); document.removeEventListener("visibilitychange", hide); clearTimeout(expire.current); sfx.dispose(); };
  }, [sfx]);
  useEffect(() => { sfx.enabled = sound; if (!sound) sfx.cancel(); }, [sound, sfx]);
  useEffect(() => { sfx.calm = quiet; if (quiet) { combo.current = { count: 0, at: -Infinity }; setCelebration(c => c ? { ...c, animated: false, combo: 1 } : c); } }, [quiet, sfx]);
  const remember = (key: string, value: boolean) => { try { localStorage.setItem(key, String(value)); } catch {} };
  function trigger(kind: EffectEvent, count = 1, removed = 0, clamped = false) {
    if (document.hidden) return;
    sfx.play(kind, count, removed, clamped);
    if (kind !== "strategy" && kind !== "lock" && kind !== "clamp") return;
    const now = performance.now();
    combo.current = nextCombo(combo.current, now, quiet);
    const accepted = flashTimeline([...flashes.current.filter(t => now - t < 2000), now]);
    const animated = !quiet && accepted.at(-1) === now;
    flashes.current = accepted;
    setCelebration({ id: ++serial.current, kind, combo: combo.current.count, animated });
    clearTimeout(expire.current); expire.current = setTimeout(() => setCelebration(null), 1800);
  }
  return <Context.Provider value={{ calm, sound, reduced, quiet, sfx, celebration, trigger,
    toggleCalm: () => { remember("parrot-calm", !calm); setCalm(!calm); },
    toggleSound: () => { remember("parrot-sound", !sound); setSound(!sound); if (!sound) void sfx.unlock(); },
  }}>{children}</Context.Provider>;
}
export function FunControls() {
  const fx = useParrotEffects();
  return <div className="parrot-fun-controls">
    <button type="button" className="parrot-button parrot-button--small" aria-label={`Sound effects ${fx.sound ? "on" : "off"}`} aria-pressed={fx.sound} onClick={fx.toggleSound}><span aria-hidden="true">{fx.sound ? "🔊" : "🔇"}</span> Sound {fx.sound ? "on" : "off"}</button>
    <button type="button" className="parrot-button parrot-button--small" aria-pressed={fx.calm} onClick={fx.toggleCalm}>Calm mode {fx.calm ? "on" : "off"}</button>
  </div>;
}
export function Fever() {
  const { celebration, quiet } = useParrotEffects();
  return <div className="parrot-fever-slot" aria-live="polite">
    {celebration && <div key={celebration.id} className={`parrot-fever ${celebration.animated && !quiet ? "is-animated" : "is-static"}`}>
      <div className="fever-rays" aria-hidden="true" />
      <strong className="fever-banner">{celebration.kind === "lock" ? "LOCKED IN!" : celebration.kind === "clamp" ? "BOUNDED BY CODE" : "STRATEGY SET!"} {celebration.combo > 1 && <small>×{celebration.combo}</small>}</strong>
      {celebration.animated && !quiet && <Feathers />}
    </div>}
  </div>;
}
function Feathers() {
  const canvas = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const node = canvas.current, ctx = node?.getContext("2d");
    if (!node || !ctx) return;
    const width = node.clientWidth, height = node.clientHeight, dpr = Math.min(2, devicePixelRatio || 1);
    node.width = width * dpr; node.height = height * dpr; ctx.scale(dpr, dpr);
    const particles = Array.from({ length: particleBudget(24, false) }, (_, i) => ({ angle: i * Math.PI * 2 / 24, speed: 45 + i % 5 * 19, color: ["#70d655", "#e9b94d", "#ef9447"][i % 3] }));
    const start = performance.now(); let frame = 0;
    const draw = (now: number) => {
      ctx.clearRect(0, 0, width, height);
      if (!particleAlive(start, now)) return;
      const elapsed = (now - start) / 900;
      ctx.globalAlpha = 1 - elapsed;
      for (const p of particles) {
        ctx.save(); ctx.translate(width / 2 + Math.cos(p.angle) * p.speed * elapsed, height / 2 + Math.sin(p.angle) * p.speed * elapsed + elapsed * elapsed * 35);
        ctx.rotate(p.angle + elapsed * 3); ctx.fillStyle = p.color; ctx.beginPath(); ctx.ellipse(0, 0, 7, 2.5, 0, 0, Math.PI * 2); ctx.fill(); ctx.restore();
      }
      frame = requestAnimationFrame(draw);
    };
    frame = requestAnimationFrame(draw);
    return () => { cancelAnimationFrame(frame); ctx.clearRect(0, 0, width, height); particles.length = 0; };
  }, []);
  return <canvas ref={canvas} className="parrot-feathers" aria-hidden="true" />;
}

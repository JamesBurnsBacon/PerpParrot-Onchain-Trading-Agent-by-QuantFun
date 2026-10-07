"use client";
import { useEffect, useState, type ReactNode, type CSSProperties } from "react";
import { useParrotEffects } from "./ParrotEffects";

export function Icon({ kind }: { kind: "back" | "close" | "check" | "pause" | "alert" | "arrow" | "sound" | "moon" }) {
  const paths = { back: "M19 12H5m6-6-6 6 6 6", close: "m6 6 12 12M6 18 18 6", check: "m5 12 4 4L19 6", pause: "M8 5v14M16 5v14", alert: "M12 8v5m0 4h.01M3 20 12 3l9 17Z", arrow: "M5 12h14m-6-6 6 6-6 6", sound: "m4 9 5 0 5-4v14l-5-4H4Zm14-2q5 5 0 10", moon: "M19 15A8 8 0 0 1 9 5a8 8 0 1 0 10 10Z" };
  return <svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={paths[kind]} /></svg>;
}

export function DryBird() {
  return <span className="dry-bird" role="img" aria-label="dry run"><svg viewBox="0 0 48 40" width="42" height="35" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><path d="M10 27C1 8 30 2 32 17l9 4-10 5c-3 10-15 9-21 1Zm2-3 12-6-3 11M16 33l-2 5m10-5 2 5" /><circle cx="27" cy="16" r="1" fill="currentColor" /></svg><b>dry</b></span>;
}

export function CountUp({ value, prefix = "", suffix = "", digits = 0 }: { value: number; prefix?: string; suffix?: string; digits?: number }) {
  const quiet = useParrotEffects()?.quiet;
  const [shown, setShown] = useState(value);
  useEffect(() => {
    if (quiet || window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) { setShown(value); return; }
    let frame = 0;
    const start = performance.now();
    const tick = (now: number) => {
      const p = Math.min(1, (now - start) / 650);
      setShown(value * (1 - (1 - p) ** 3));
      if (p < 1) frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [value, quiet]);
  const format = (n: number) => `${prefix}${n.toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits })}${suffix}`;
  return <span className="count-up" role="img" aria-label={format(value)}><span aria-hidden="true">{format(shown)}</span></span>;
}

// Region changes never steal microphone focus. Keyboard users can tab to this bounded stage.
export function StageCard({ label, children, onClose }: { label: string; children: ReactNode; onClose: () => void }) {
  return <section className="parrot-live-card" aria-label={`Live card: ${label}`}>
    <button type="button" className="stage-close" onClick={onClose} aria-label="Close this card"><Icon kind="close" /></button>
    <p className="sr-only" role="status">{label} is on screen.</p>
    {children}
  </section>;
}

export function SavedStamp({ id, hash, demo = false }: { id: string | null; hash: string; demo?: boolean }) {
  return <div className="saved-ticket" role="status">
    <span className="ticket-punch" aria-hidden="true"><Icon kind="check" /></span>
    <strong className="pending-stamp">{demo ? "SIMULATED" : "PENDING"}</strong>
    <span className="ticket-id" title={id ?? undefined}>{demo ? "Not saved" : id ?? "—"}</span>
    <code title={hash}>{hash.slice(0, 12)}…</code>
    <span className="sr-only">{demo ? "Simulated request. Nothing was saved; no operator will review it." : `Request ${id} saved. Awaiting operator freeze. No orders were placed.`}</span>
  </div>;
}

export function StageBurst() {
  const fx = useParrotEffects();
  if (!fx.celebration?.animated || fx.quiet) return null;
  return <div key={fx.celebration.id} className="stage-burst" aria-hidden="true">{Array.from({ length: 18 }, (_, i) => <i key={i} style={{ "--angle": `${i * 137.5}deg`, "--distance": `${95 + i % 4 * 32}px`, "--feather": ["#6cc04a", "#f29a2e", "#eac744", "#9683bf", "#639ec4"][i % 5] } as CSSProperties} />)}</div>;
}

export function StatValue({ value }: { value: string }) {
  const numeric = /^([#$+−-]?)([0-9]+(?:\.[0-9]+)?)(%?)$/.exec(value);
  if (!numeric) return <>{value}</>;
  const sign = numeric[1] === "-" || numeric[1] === "−" ? -1 : 1;
  return <CountUp value={Number(numeric[2]) * sign} prefix={sign < 0 ? "" : numeric[1]} suffix={numeric[3]} digits={numeric[2].split(".")[1]?.length ?? 0} />;
}

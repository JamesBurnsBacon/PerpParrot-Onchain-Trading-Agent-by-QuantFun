import { useCallback, useEffect, useRef, useState } from "react";
import { holdProgress } from "../../lib/parrot";

export function HoldButton({ disabled, onConfirm }: { disabled: boolean; onConfirm: () => void }) {
  const [progress, setProgress] = useState(0);
  const frame = useRef<number | null>(null);
  const holding = useRef(false);
  const completed = useRef(false);
  const cancel = useCallback(() => {
    holding.current = false;
    if (frame.current !== null) cancelAnimationFrame(frame.current);
    frame.current = null;
    setProgress(0);
  }, []);
  useEffect(() => {
    const hide = () => { if (document.hidden) cancel(); };
    window.addEventListener("blur", cancel);
    document.addEventListener("visibilitychange", hide);
    return () => { cancel(); window.removeEventListener("blur", cancel); document.removeEventListener("visibilitychange", hide); };
  }, [cancel]);
  useEffect(() => { if (disabled) cancel(); }, [disabled, cancel]);

  function begin() {
    if (disabled || holding.current || completed.current) return;
    holding.current = true;
    const start = performance.now();
    const tick = (now: number) => {
      if (!holding.current) return;
      const value = holdProgress(start, now, 1200);
      setProgress(value);
      if (value === 1) {
        holding.current = false;
        completed.current = true;
        frame.current = null;
        onConfirm();
      } else frame.current = requestAnimationFrame(tick);
    };
    frame.current = requestAnimationFrame(tick);
  }
  function release() { cancel(); completed.current = false; }
  return <div>
    <button type="button" className="parrot-button parrot-button--primary parrot-hold w-full" disabled={disabled}
      aria-describedby="parrot-hold-help"
      onPointerDown={event => { if (event.button === 0) { event.currentTarget.setPointerCapture(event.pointerId); begin(); } }}
      onPointerUp={release} onPointerLeave={release} onPointerCancel={release} onLostPointerCapture={release} onBlur={release}
      onKeyDown={event => { if (event.key === " " || event.key === "Enter") { event.preventDefault(); if (!event.repeat) begin(); } else if (event.key === "Escape") release(); }}
      onKeyUp={event => { if (event.key === " " || event.key === "Enter") { event.preventDefault(); release(); } }}
      onContextMenu={event => { event.preventDefault(); release(); }}>
      <svg className="shrink-0" width="30" height="30" viewBox="0 0 30 30" aria-hidden="true">
        <circle cx="15" cy="15" r="12" fill="none" stroke="currentColor" strokeWidth="3" opacity=".2" />
        <circle cx="15" cy="15" r="12" fill="none" stroke="currentColor" strokeWidth="3" pathLength="1" strokeDasharray="1" strokeDashoffset={1 - progress} transform="rotate(-90 15 15)" />
        <path d="M11 14v-3a4 4 0 018 0v3m-9 0h10v8H10z" fill="none" stroke="currentColor" strokeWidth="1.4" />
      </svg>
      Lock this strategy
    </button>
    <p id="parrot-hold-help" className="mt-2 text-center text-xs" style={{ color: "var(--ink-2)" }}>Hold for 1.2 seconds · mouse, touch, Space or Enter. Release to cancel.</p>
    <p className="sr-only" role="status">{progress > 0 && progress < 1 ? "Keep holding to save a pending request." : ""}</p>
  </div>;
}

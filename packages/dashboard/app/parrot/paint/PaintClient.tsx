"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { SAMPLE_WALLET_IDS } from "../../../../shared/sample-wallet-ids";
import { Badge } from "../../../components/parrot/Badge";
import { captionAt, paintFlock, type Stroke } from "../../../lib/parrot-paint";

function draw(ctx: CanvasRenderingContext2D, stroke: Stroke, index: number) {
  ctx.fillStyle = ctx.strokeStyle = stroke.color;
  ctx.lineWidth = stroke.width;
  ctx.lineCap = ctx.lineJoin = "round";
  ctx.globalAlpha = 0.32;
  for (let bristle = 0; bristle < 4; bristle++) {
    const dx = Math.sin(index * 7 + bristle * 3) * 1.6, dy = Math.cos(index * 3 + bristle * 7) * 1.6;
    ctx.beginPath();
    stroke.points.forEach(([x, y], p) => {
      if (stroke.tool === "dab") {
        ctx.moveTo(x + dx + stroke.width / 2, y + dy);
        ctx.arc(x + dx, y + dy, stroke.width / 2, 0, Math.PI * 2);
      } else if (p === 0) ctx.moveTo(x + dx, y + dy);
      else ctx.lineTo(x + dx, y + dy);
    });
    if (stroke.tool === "dab") ctx.fill(); else ctx.stroke();
  }
  ctx.globalAlpha = 1;
}

export default function PaintClient() {
  const canvas = useRef<HTMLCanvasElement>(null);
  const [ids, setIds] = useState<string[]>(() => SAMPLE_WALLET_IDS.slice(0, 8));
  const [replay, setReplay] = useState(0), [speed, setSpeed] = useState(1), [progress, setProgress] = useState(0);
  const speedRef = useRef(speed);
  const strokes = useMemo(() => paintFlock(ids), [ids]);
  useEffect(() => { speedRef.current = speed; }, [speed]);
  useEffect(() => {
    const ctx = canvas.current?.getContext("2d");
    if (!ctx) return;
    ctx.globalAlpha = 1;
    ctx.fillStyle = "#f5eddb";
    ctx.fillRect(0, 0, 800, 500);
    setProgress(0);
    let frame = 0, drawn = 0, elapsed = 0, previous: number | undefined;
    const motion = window.matchMedia("(prefers-reduced-motion: reduce)");
    const drawThrough = (end: number) => {
      while (drawn < end) { draw(ctx, strokes[drawn], drawn); drawn++; }
      setProgress(drawn / strokes.length);
    };
    const finish = () => { cancelAnimationFrame(frame); drawThrough(strokes.length); };
    const tick = (now: number) => {
      elapsed += previous === undefined ? 0 : Math.min(now - previous, 100) * speedRef.current;
      previous = now;
      drawThrough(Math.min(strokes.length, Math.floor(elapsed / 65) + 1));
      if (drawn < strokes.length) frame = requestAnimationFrame(tick);
    };
    const onMotion = () => { if (motion.matches) finish(); };
    if (motion.matches) drawThrough(strokes.length);
    else frame = requestAnimationFrame(tick);
    motion.addEventListener("change", onMotion);
    return () => {
      cancelAnimationFrame(frame);
      motion.removeEventListener("change", onMotion);
    };
  }, [strokes, replay]);

  function newFlock() {
    const pool: string[] = [...SAMPLE_WALLET_IDS];
    for (let i = pool.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [pool[i], pool[j]] = [pool[j], pool[i]];
    }
    setIds(pool.slice(0, 8));
  }

  return <main className="paint-page">
    <header><Badge kind="SAMPLE DATA" /><p className="paint-kicker">The Parrot’s tiny studio · wet paint</p>
      <h1>Paint the flock</h1><p>Eight little birds, one brushstroke at a time.</p></header>
    <canvas ref={canvas} width={800} height={500} role="img"
      aria-label="A brushstroke painting of eight sample wallet birds on green hills beneath a blue sky">
      Eight clay birds painted from sample wallet identities.
    </canvas>
    <progress value={progress} max={1} aria-label="Painting progress" />
    <p className="paint-caption" role="status">{captionAt(progress, ids.length)}</p>
    <div className="paint-controls" aria-label="Painting controls">
      <button onClick={() => setReplay(value => value + 1)}>Replay</button>
      {[1, 2, 4].map(value => <button key={value} aria-pressed={speed === value} onClick={() => setSpeed(value)}>{value}x</button>)}
      <button onClick={newFlock}>New flock</button>
    </div>
    <p className="paint-note">Offline PoC · sample IDs only · painted by code, no model.<br />No wallet metrics here: every bird has the neutral Steady colour.</p>
    <footer>Inspired by Stillwet by Alice (stillwet.art, MIT). No code or paintings reused.</footer>
  </main>;
}

import { useEffect, useRef, useState } from "react";
import { createFlightEngine } from "../art/flight-engine";
import type { FlightMode } from "../art/flight-engine";
import "./seed-atlas.css";

function SeedPreview({
  seed,
  mode,
  intensity,
}: {
  seed: number;
  mode: FlightMode;
  intensity: number;
}) {
  const canvas = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const element = canvas.current;
    if (!element) return;
    const ctx = element.getContext("2d");
    if (!ctx) return;
    const engine = createFlightEngine({ seed, mode, intensity });
    for (let step = 0; step < 75; step++) engine.advance();
    ctx.fillStyle = "#111b39";
    ctx.fillRect(0, 0, 180, 100);
    for (const particle of engine.particles) {
      ctx.beginPath();
      for (let point = 0; point < particle.count; point++) {
        const p =
          particle.history[
            (particle.cursor - particle.count + point + 26) % 26
          ];
        if (point) ctx.lineTo(p.x * 180, p.y * 100);
        else ctx.moveTo(p.x * 180, p.y * 100);
      }
      ctx.strokeStyle = particle.color;
      ctx.globalAlpha = 0.8;
      ctx.lineWidth = particle.size * 0.7;
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
  }, [seed, mode, intensity]);
  return <canvas ref={canvas} width={180} height={100} aria-hidden="true" />;
}
export function SeedAtlas({
  seed,
  mode,
  intensity,
  onSelect,
}: {
  seed: number;
  mode: FlightMode;
  intensity: number;
  onSelect: (seed: number) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  return (
    <details
      className="seed-atlas"
      onToggle={(event) => setExpanded(event.currentTarget.open)}
    >
      <summary>
        Explore nine variations{" "}
        <span>Same rules. Different starting conditions.</span>
      </summary>
      {expanded && (
        <div
          className="seed-atlas-grid"
          role="group"
          aria-label="Reproducible artwork seeds"
        >
          {Array.from({ length: 9 }, (_, index) => 47 + index).map((value) => (
            <button
              key={value}
              aria-label={`Select artwork seed ${value}`}
              aria-pressed={seed === value}
              onClick={() => onSelect(value)}
            >
              <SeedPreview seed={value} mode={mode} intensity={intensity} />
              <span>Seed {value}</span>
            </button>
          ))}
        </div>
      )}
      <p>
        Static previews at 75 simulation steps. The stage continues from its own
        frame after selection; pointer history changes its evolution.
      </p>
    </details>
  );
}

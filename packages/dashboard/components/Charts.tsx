"use client";
import { useState } from "react";
import type { Run } from "../lib/data";
import { ordersOf, pct, runTime, time } from "../lib/data";
import { useWidth } from "./useWidth";

export function Panel({ title, meta, children }: { title: string; meta?: React.ReactNode; children: React.ReactNode }) {
  return (
    <section className="min-w-0 rounded-xl p-4" style={{ background: "var(--surface)", border: "1px solid var(--ring)" }}>
      <header className="mb-3 flex items-baseline justify-between gap-2">
        <h2 className="text-sm font-semibold">{title}</h2>
        {meta && <span className="text-xs" style={{ color: "var(--muted)" }}>{meta}</span>}
      </header>
      {children}
    </section>
  );
}

// Labeled empty state: never invented data.
export function Waiting({ what, source }: { what: string; source: string }) {
  return (
    <div className="flex h-48 flex-col items-center justify-center gap-1 rounded-lg text-xs" style={{ border: "1px dashed var(--axis)", color: "var(--muted)" }}>
      <span style={{ color: "var(--ink-2)" }}>{what}</span>
      <span>{source}</span>
    </div>
  );
}

// Hero number with an optional signed change (tone + arrow) and a neutral note.
export function StatTile({ label, value, tone, note }: { label: string; value: string; tone?: "up" | "down"; note?: string }) {
  return (
    <div className="min-w-0 rounded-xl p-4" style={{ background: "var(--surface)", border: "1px solid var(--ring)" }}>
      <div className="truncate text-xs" style={{ color: "var(--ink-2)" }}>{label}</div>
      <div className="mt-1 flex items-baseline gap-1.5 text-2xl font-semibold">
        {tone && (
          <span className="text-sm" style={{ color: tone === "up" ? "var(--up)" : "var(--critical)" }} aria-label={tone === "up" ? "up" : "down"}>
            {tone === "up" ? "▲" : "▼"}
          </span>
        )}
        {value}
      </div>
      {note && <div className="mt-0.5 text-xs" style={{ color: "var(--muted)" }}>{note}</div>}
    </div>
  );
}

// Current exposures: long right (blue), short left (red), from a zero line.
export function ExposureBars({ exposures }: { exposures: { asset: string; fraction: number }[] }) {
  const [ref, width] = useWidth<HTMLDivElement>(480);
  const [hover, setHover] = useState<string | null>(null);
  const rows = [...exposures].sort((a, b) => Math.abs(b.fraction) - Math.abs(a.fraction)).slice(0, 14);
  const hidden = exposures.length - rows.length;
  const max = Math.max(...rows.map((r) => Math.abs(r.fraction)), 0.01);
  const labelW = 92;
  const valueW = 52;
  const half = (width - labelW - valueW * 2) / 2;
  const mid = labelW + valueW + half;
  const rowH = 20;
  return (
    <div ref={ref} className="min-w-0 overflow-hidden">
      <svg width={width} height={rows.length * rowH + 4} role="img" aria-label="Exposures by asset, as a share of equity">
        <line x1={mid} x2={mid} y1={0} y2={rows.length * rowH} stroke="var(--axis)" />
        {rows.map((r, i) => {
          const w = Math.max(2, (Math.abs(r.fraction) / max) * half);
          const long = r.fraction >= 0;
          const yy = i * rowH + 3;
          return (
            <g key={r.asset} onPointerEnter={() => setHover(r.asset)} onPointerLeave={() => setHover(null)}>
              <rect x={0} y={yy - 3} width={width} height={rowH} fill={hover === r.asset ? "var(--grid)" : "transparent"} opacity={0.5} />
              <text x={labelW - 8} y={yy + 7} dy="0.32em" textAnchor="end" fontSize="11" fill="var(--ink-2)">{r.asset}</text>
              <rect x={long ? mid + 1 : mid - 1 - w} y={yy} width={w} height={14} rx={4} fill={long ? "var(--long)" : "var(--short)"} />
              <text
                x={long ? mid + w + 6 : mid - w - 6}
                y={yy + 7}
                dy="0.32em"
                textAnchor={long ? "start" : "end"}
                fontSize="11"
                fill="var(--ink)"
                className="tabular"
              >
                {pct(r.fraction * 100, 1)}
              </text>
            </g>
          );
        })}
      </svg>
      <div className="mt-2 flex items-center gap-4 text-xs" style={{ color: "var(--ink-2)" }}>
        <span className="inline-flex items-center gap-1.5"><span className="inline-block h-2.5 w-2.5 rounded-sm" style={{ background: "var(--long)" }} />Long</span>
        <span className="inline-flex items-center gap-1.5"><span className="inline-block h-2.5 w-2.5 rounded-sm" style={{ background: "var(--short)" }} />Short</span>
        <span style={{ color: "var(--muted)" }}>% of equity{hidden > 0 ? ` · ${hidden} smaller not shown` : ""}</span>
      </div>
    </div>
  );
}

export const RUN_STATUS = {
  executed: { color: "var(--good)", icon: "●", label: "Executed" },
  skipped_paused: { color: "var(--warning)", icon: "‖", label: "Paused" },
  failed: { color: "var(--critical)", icon: "✕", label: "Failed" },
} as const;

// One cell per mirror run (newest right); hover for details.
export function RunStrip({ runs }: { runs: Run[] }) {
  const [hover, setHover] = useState<Run | null>(null);
  const recent = [...runs].filter((r) => r.kind === "report").sort((a, b) => a.startedAt - b.startedAt).slice(-72);
  return (
    <div>
      <div className="flex flex-wrap gap-[2px]">
        {recent.map((r) => (
          <button
            key={r.id}
            aria-label={`${r.runId}: ${RUN_STATUS[r.status].label}`}
            className="h-7 w-3 rounded-[3px] outline-offset-2"
            style={{ background: RUN_STATUS[r.status].color, opacity: hover && hover.id !== r.id ? 0.55 : 1 }}
            onPointerEnter={() => setHover(r)}
            onFocus={() => setHover(r)}
            onPointerLeave={() => setHover(null)}
            onBlur={() => setHover(null)}
          />
        ))}
      </div>
      <div className="mt-2 min-h-10 text-xs" style={{ color: "var(--ink-2)" }}>
        {hover ? (
          <span className="tabular">
            <span className="font-semibold" style={{ color: "var(--ink)" }}>{RUN_STATUS[hover.status].icon} {RUN_STATUS[hover.status].label}</span>{" "}
            {time(runTime(hover))} · {ordersOf(hover)} orders{hover.dryRun ? " (dry run)" : ""}
            {hover.error ? ` · ${hover.error}` : ""}
          </span>
        ) : (
          <span className="flex gap-4">
            {Object.values(RUN_STATUS).map((s) => (
              <span key={s.label} className="inline-flex items-center gap-1"><span style={{ color: s.color }}>{s.icon}</span>{s.label}</span>
            ))}
          </span>
        )}
      </div>
    </div>
  );
}

// Funnel: one bar per stage, ordinal blue ramp, counts labeled.
export function Funnel({ steps }: { steps: { stage: string; label: string; count: number }[] }) {
  const [ref, width] = useWidth<HTMLDivElement>(480);
  const max = Math.max(...steps.map((s) => s.count), 1);
  const ramp = ["var(--funnel-1)", "var(--funnel-2)", "var(--funnel-3)", "var(--funnel-4)", "var(--funnel-5)"];
  const labelW = 120;
  return (
    <div ref={ref} className="min-w-0 overflow-hidden">
      <svg width={width} height={steps.length * 26} role="img" aria-label="Selection funnel">
        {steps.map((s, i) => {
          // Square-root scale so the last stages (25, then 5–25) stay visible next to ~47k.
          const w = Math.max(3, (Math.sqrt(s.count) / Math.sqrt(max)) * (width - labelW - 64));
          return (
            <g key={s.stage}>
              <text x={labelW - 8} y={i * 26 + 10} dy="0.32em" textAnchor="end" fontSize="11" fill="var(--ink-2)">{s.label}</text>
              <rect x={labelW} y={i * 26 + 2} width={w} height={16} rx={4} fill={ramp[Math.min(i, ramp.length - 1)]} />
              <text x={labelW + w + 6} y={i * 26 + 10} dy="0.32em" fontSize="11" fill="var(--ink)" className="tabular">
                {s.count.toLocaleString()}
              </text>
            </g>
          );
        })}
      </svg>
      <div className="mt-1 text-xs" style={{ color: "var(--muted)" }}>Bar length ∝ √count</div>
    </div>
  );
}

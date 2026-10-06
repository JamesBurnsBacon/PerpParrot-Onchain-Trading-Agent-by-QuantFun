"use client";
import { useMemo, useState } from "react";
import type { Series } from "../lib/data";
import { useWidth } from "./useWidth";

type Props = {
  series: Series[];
  height?: number;
  format: (v: number) => string;
  xFormat: (t: number) => string;
  zeroLine?: boolean;
};

const BASE_PAD = { top: 12, right: 132, bottom: 26, left: 52 };

const niceTicks = (min: number, max: number, count = 4) => {
  const span = max - min || 1;
  const step = 10 ** Math.floor(Math.log10(span / count));
  const nice = [1, 2, 2.5, 5, 10].map((m) => m * step).find((s) => span / s <= count) ?? step * 10;
  const ticks: number[] = [];
  for (let v = Math.ceil(min / nice) * nice; v <= max + 1e-9; v += nice) ticks.push(Number(v.toFixed(10)));
  return ticks;
};

// Time ticks on round local times: 10 min … 30 days (multi-day steps count from the epoch).
const TIME_STEPS = [10, 30, 60, 120, 360, 720, 1440, 2880, 7200, 14400, 43200].map((m) => m * 60e3);
const timeTicks = (min: number, max: number, count: number) => {
  const step = TIME_STEPS.find((s) => (max - min) / s <= count) ?? TIME_STEPS.at(-1)!;
  const off = new Date(min).getTimezoneOffset() * 60e3;
  const ticks: number[] = [];
  for (let t = Math.ceil((min - off) / step) * step + off; t <= max; t += step) ticks.push(t);
  return ticks;
};

// Value of a series at time t: the last point at or before t.
const valueAt = (points: [number, number][], t: number) => {
  let found: number | undefined;
  for (const [pt, v] of points) {
    if (pt > t) break;
    found = v;
  }
  return found;
};

export function LineChart({ series, height = 300, format, xFormat, zeroLine = true }: Props) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [hoverT, setHoverT] = useState<number | null>(null);
  const [table, setTable] = useState(false);
  // Narrow screens: less room for end labels.
  const PAD = width < 480 ? { ...BASE_PAD, right: 112 } : BASE_PAD;

  const { xs, x, y, yTicks, times } = useMemo(() => {
    const all = series.flatMap((s) => s.points);
    const tMin = Math.min(...all.map((p) => p[0]));
    const tMax = Math.max(...all.map((p) => p[0]));
    let vMin = Math.min(...all.map((p) => p[1]), zeroLine ? 0 : Infinity);
    let vMax = Math.max(...all.map((p) => p[1]), zeroLine ? 0 : -Infinity);
    if (vMax - vMin < 0.2) {
      vMin -= 0.1;
      vMax += 0.1;
    }
    const yTicks = niceTicks(vMin, vMax);
    const lo = Math.min(vMin, yTicks[0]);
    const hi = Math.max(vMax, yTicks.at(-1)!);
    const plotW = width - PAD.left - PAD.right;
    const plotH = height - PAD.top - PAD.bottom;
    const x = (t: number) => PAD.left + (tMax === tMin ? plotW : ((t - tMin) / (tMax - tMin)) * plotW);
    const y = (v: number) => PAD.top + plotH - ((v - lo) / (hi - lo || 1)) * plotH;
    const times = [...new Set(all.map((p) => p[0]))].sort((a, b) => a - b);
    const xs = timeTicks(tMin, tMax, Math.max(3, Math.floor(plotW / 110)));
    return { xs: xs.length ? xs : [tMin], x, y, yTicks, times };
  }, [series, width, height, zeroLine]); // PAD derives from width

  if (!series.length || !times.length) return null;

  const onMove = (e: React.PointerEvent<SVGRectElement>) => {
    const box = (e.currentTarget.ownerSVGElement as SVGSVGElement).getBoundingClientRect();
    const px = e.clientX - box.left;
    let best = times[0];
    for (const t of times) if (Math.abs(x(t) - px) < Math.abs(x(best) - px)) best = t;
    setHoverT(best);
  };

  // Direct labels at line ends, nudged apart so they don't collide.
  const ends = series
    .map((s) => ({ s, v: s.points.at(-1)![1], yy: y(s.points.at(-1)![1]) }))
    .sort((a, b) => a.yy - b.yy);
  for (let i = 1; i < ends.length; i++) if (ends[i].yy - ends[i - 1].yy < 14) ends[i].yy = ends[i - 1].yy + 14;

  const hoverRows = hoverT === null ? [] : series.map((s) => ({ s, v: valueAt(s.points, hoverT) })).filter((r) => r.v !== undefined);
  const tooltipLeft = hoverT === null ? 0 : Math.min(x(hoverT) + 12, width - 200);

  return (
    <div ref={ref} className="relative min-w-0 overflow-hidden">
      <div className="mb-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs" style={{ color: "var(--ink-2)" }}>
        {series.map((s) => (
          <span key={s.id} className="inline-flex items-center gap-1.5">
            <svg width="16" height="8" aria-hidden>
              <line x1="0" x2="16" y1="4" y2="4" stroke={s.color} strokeWidth="2" strokeDasharray={s.reference ? "4 3" : undefined} />
            </svg>
            {s.label}
          </span>
        ))}
        <button className="ml-auto underline-offset-2 hover:underline" style={{ color: "var(--muted)" }} onClick={() => setTable(!table)}>
          {table ? "Chart" : "Table"}
        </button>
      </div>

      {table ? (
        <div className="max-h-72 overflow-auto text-xs">
          <table className="tabular w-full">
            <thead style={{ color: "var(--muted)" }}>
              <tr>
                <th className="py-1 text-left font-normal">Time</th>
                {series.map((s) => (
                  <th key={s.id} className="py-1 text-right font-normal">{s.label}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {[...times].reverse().map((t) => (
                <tr key={t} className="border-t" style={{ borderColor: "var(--grid)" }}>
                  <td className="py-1">{xFormat(t)}</td>
                  {series.map((s) => {
                    const v = valueAt(s.points, t);
                    return <td key={s.id} className="py-1 text-right">{v === undefined ? "—" : format(v)}</td>;
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <svg width={width} height={height} role="img" aria-label={`Line chart: ${series.map((s) => s.label).join(", ")}`}>
          {yTicks.map((v) => (
            <g key={v}>
              <line x1={PAD.left} x2={width - PAD.right} y1={y(v)} y2={y(v)} stroke={v === 0 && zeroLine ? "var(--axis)" : "var(--grid)"} strokeWidth="1" />
              <text x={PAD.left - 8} y={y(v)} dy="0.32em" textAnchor="end" fontSize="11" fill="var(--muted)" className="tabular">
                {format(v)}
              </text>
            </g>
          ))}
          {xs.map((t) => (
            <text key={t} x={x(t)} y={height - 6} textAnchor="middle" fontSize="11" fill="var(--muted)" className="tabular">
              {xFormat(t)}
            </text>
          ))}
          {series.map((s) => (
            <polyline
              key={s.id}
              fill="none"
              stroke={s.color}
              strokeWidth="2"
              strokeLinejoin="round"
              strokeLinecap="round"
              strokeDasharray={s.reference ? "5 4" : undefined}
              points={s.points.map(([t, v]) => `${x(t)},${y(v)}`).join(" ")}
            />
          ))}
          {ends.map(({ s, v, yy }) => (
            <g key={s.id}>
              <circle cx={x(s.points.at(-1)![0])} cy={y(v)} r="4" fill={s.color} stroke="var(--surface)" strokeWidth="2" />
              <text x={width - PAD.right + 10} y={yy} dy="0.32em" fontSize="11" fill="var(--ink-2)" className="tabular">
                <tspan fontWeight="600" fill="var(--ink)">{format(v)}</tspan> {s.short}
              </text>
            </g>
          ))}
          {hoverT !== null && <line x1={x(hoverT)} x2={x(hoverT)} y1={PAD.top} y2={height - PAD.bottom} stroke="var(--axis)" strokeWidth="1" />}
          <rect
            x={PAD.left}
            y={PAD.top}
            width={Math.max(0, width - PAD.left - PAD.right)}
            height={height - PAD.top - PAD.bottom}
            fill="transparent"
            onPointerMove={onMove}
            onPointerLeave={() => setHoverT(null)}
          />
        </svg>
      )}

      {!table && hoverT !== null && hoverRows.length > 0 && (
        <div
          className="pointer-events-none absolute top-8 z-10 min-w-44 rounded-md px-3 py-2 text-xs shadow-lg"
          style={{ left: tooltipLeft, background: "var(--surface)", border: "1px solid var(--ring)" }}
        >
          <div className="mb-1" style={{ color: "var(--muted)" }}>{xFormat(hoverT)}</div>
          {hoverRows.map(({ s, v }) => (
            <div key={s.id} className="flex items-center gap-2 py-0.5">
              <svg width="12" height="6" aria-hidden>
                <line x1="0" x2="12" y1="3" y2="3" stroke={s.color} strokeWidth="2" strokeDasharray={s.reference ? "3 2" : undefined} />
              </svg>
              <span className="tabular font-semibold" style={{ color: "var(--ink)" }}>{format(v!)}</span>
              <span style={{ color: "var(--ink-2)" }}>{s.label}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

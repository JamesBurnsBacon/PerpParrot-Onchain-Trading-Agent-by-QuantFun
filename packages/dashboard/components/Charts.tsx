"use client";
import { useState } from "react";
import type { PaperView, Run, Series } from "../lib/data";
import { ordersOf, pct, runTime, time, usd } from "../lib/data";
import { CountUp } from "./lp/CountUp";
import { Parrot } from "./lp/ParrotSymbols";
import { useWidth } from "./useWidth";

// `id` is an anchor target; `tone` picks the heading chip color and `peek` lets a parrot look over the edge
// (both only show under the landing theme, see app/lp.css).
export function Panel({ title, meta, children, id, tone = 1, peek }: { title: string; meta?: React.ReactNode; children: React.ReactNode; id?: string; tone?: 1 | 2 | 3 | 4 | 5; peek?: "left" | "right" }) {
  return (
    <section id={id} data-tone={tone} className="lp-panel lp-reveal min-w-0 rounded-xl p-4" style={{ background: "var(--surface)", border: "1px solid var(--ring)" }}>
      {peek && (
        <div className={`lp-peek${peek === "left" ? " left" : ""}`} aria-hidden="true">
          <Parrot />
        </div>
      )}
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
// color: the tile's line key in the performance chart (dashed for a reference line).
// count: the number behind `value`, counted up once when the tile first scrolls into view.
export function StatTile({ label, value, tone, note, color, reference, count }: { label: string; value: string; tone?: "up" | "down"; note?: string; color?: string; reference?: boolean; count?: { value: number; format: (n: number) => string } }) {
  return (
    <div className="lp-tile lp-reveal min-w-0 rounded-xl p-4" style={{ background: "var(--surface)", border: "1px solid var(--ring)", ["--tab" as string]: color ?? "var(--axis)" }}>
      <div className="flex items-center gap-1.5 truncate text-xs" style={{ color: "var(--ink-2)" }}>
        {color && (
          <svg width="14" height="8" aria-hidden className="shrink-0">
            <line x1="0" x2="14" y1="4" y2="4" stroke={color} strokeWidth="3" strokeLinecap="round" strokeDasharray={reference ? "4 3" : undefined} />
          </svg>
        )}
        {label}
      </div>
      <div className="lp-tile-value mt-1 flex items-baseline gap-1.5 text-2xl font-semibold" data-tone={tone}>
        {tone && (
          <span className="text-sm" style={{ color: tone === "up" ? "var(--up)" : "var(--critical)" }} aria-label={tone === "up" ? "up" : "down"}>
            {tone === "up" ? "▲" : "▼"}
          </span>
        )}
        {count ? <CountUp value={count.value} format={count.format} /> : value}
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
  const recent = [...runs].filter((r) => r.kind === "mirror").sort((a, b) => a.startedAt - b.startedAt).slice(-72);
  return (
    <div>
      <div className="lp-cells flex flex-wrap gap-[2px]">
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

const SKIP_LABEL: Record<string, string> = {
  BELOW_DRIFT: "within drift",
  BELOW_MIN_ORDER: "under $10",
  NOT_TRADABLE: "not tradable",
  UNKNOWN_MARKET: "no market",
  SIZE_ROUNDS_TO_ZERO: "rounds to 0",
  LEVERAGE_FAILED: "leverage failed",
  BELOW_EQUITY_BAND: "under 0.5% of equity",
  CLOSE_PENDING: "close pending (3 runs)",
  IN_FLIGHT: "earlier order in flight",
};

// Last run, per asset: the target exposure (bar, long right of the dashed zero line, short left)
// and what the executor did.
export function TargetPortfolio({ run }: { run: Run }) {
  const [ref, width] = useWidth<HTMLDivElement>(480);
  const [hover, setHover] = useState<string | null>(null);
  const equity = run.equityUsd ?? 0;
  const legs = [
    ...(run.plan?.orders ?? []).map((o) => ({
      asset: o.asset,
      target: o.targetUsd,
      action: `${o.isBuy ? "▲ buy" : "▼ sell"} ${Math.abs(o.notionalUsd).toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 })}`,
      traded: true,
    })),
    // A non-tradable leg can be both skipped (its full target) and ordered (capped to a
    // reduction): one row per asset, the order's, marked as capped.
    ...(run.plan?.skipped ?? [])
      .filter((s) => !run.plan?.orders.some((o) => o.asset === s.asset))
      .map((s) => ({ asset: s.asset, target: s.targetUsd, action: `· ${SKIP_LABEL[s.reason] ?? s.reason}`, traded: false })),
  ];
  for (const leg of legs) {
    const capped = run.plan?.skipped.find((s) => s.asset === leg.asset && leg.traded);
    if (capped) leg.action += " · capped"; // e.g. not tradable: reduce only
  }
  if (!legs.length || !(equity > 0)) return <Waiting what="Nothing to trade in the last run" source="executor /runs · plan" />;
  const rows = legs.sort((a, b) => Math.abs(b.target) - Math.abs(a.target)).slice(0, 14);
  const hidden = legs.length - rows.length;
  // Share of equity on each side of zero; 10% headroom so the longest bar ends clear of the edge.
  const largest = Math.max(...rows.map((r) => Math.abs(r.target) / equity), 0.01);
  const max = largest * 1.1;
  const labelW = 92;
  const actionW = 128;
  const pad = 12; // inside the plot, on both sides
  const half = Math.max((width - labelW - actionW - 2 * pad) / 2, 20);
  const mid = labelW + pad + half;
  const x = (usd: number) => mid + (usd / equity / max) * half;
  const rowH = 20;
  const height = rows.length * rowH + 4;
  // Unlabeled gridlines at a round step of equity, about three a side.
  const step = [0.01, 0.02, 0.05, 0.1, 0.2, 0.25, 0.5, 1, 2, 5].find((s) => max / s <= 3.5) ?? 10;
  const grid: number[] = [];
  for (let g = step; g < max; g += step) grid.push(g, -g);
  return (
    <div ref={ref} className="min-w-0 overflow-hidden">
      <svg width={width} height={height} role="img" aria-label="Target exposure per asset, last run">
        {grid.map((g) => {
          const gx = mid + (g / max) * half;
          return <line key={g} x1={gx} x2={gx} y1={0} y2={height - 4} stroke="var(--grid)" strokeWidth={1} />;
        })}
        {rows.map((r, i) => {
          const yy = i * rowH + 3;
          const long = r.target >= 0;
          const w = Math.max(2, Math.abs(x(r.target) - mid));
          return (
            <g key={r.asset} onPointerEnter={() => setHover(r.asset)} onPointerLeave={() => setHover(null)}>
              <rect x={0} y={yy - 3} width={width} height={rowH} fill={hover === r.asset ? "var(--grid)" : "transparent"} opacity={0.5} />
              <text x={labelW - 8} y={yy + 7} dy="0.32em" textAnchor="end" fontSize="11" fill="var(--ink-2)">{r.asset}</text>
              <rect x={long ? mid + 1 : mid - 1 - w} y={yy} width={w} height={14} rx={4} fill={long ? "var(--long)" : "var(--short)"} opacity={0.45} />
              <text x={width - actionW} y={yy + 7} dy="0.32em" fontSize="11" fill={r.traded ? "var(--ink)" : "var(--muted)"} className="tabular">{r.action}</text>
            </g>
          );
        })}
        <line x1={mid} x2={mid} y1={0} y2={height - 4} stroke="var(--ink)" strokeWidth={1.5} strokeDasharray="3 3" />
      </svg>
      <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs" style={{ color: "var(--ink-2)" }}>
        <span className="inline-flex items-center gap-1.5"><span className="inline-block h-2.5 w-2.5 rounded-sm opacity-45" style={{ background: "var(--long)" }} />Long</span>
        <span className="inline-flex items-center gap-1.5"><span className="inline-block h-2.5 w-2.5 rounded-sm opacity-45" style={{ background: "var(--short)" }} />Short</span>
        <span style={{ color: "var(--muted)" }}>
          {hover
            ? (() => {
                const r = rows.find((l) => l.asset === hover)!;
                return `${r.asset}: ${pct((r.target / equity) * 100, 1)} of equity`;
              })()
            : `${hidden > 0 ? `+${hidden} more` : ""}${run.plan?.marginScale !== undefined && run.plan.marginScale < 1 ? `${hidden > 0 ? " · " : ""}margin ×${run.plan.marginScale.toFixed(2)}` : ""}`}
        </span>
      </div>
    </div>
  );
}

// The paper books behind the performance chart's lines: same line key, with costs and activity.
export function PaperTable({ books, series }: { books: PaperView["books"]; series: Series[] }) {
  const rows = series.flatMap((s) => {
    const b = books.find((x) => x.id === s.bookId);
    return b ? [{ s, b }] : [];
  });
  const cost = (v: number, start: number) => `${usd(v)} (${((v / start) * 100).toFixed(2)}%)`;
  return (
    <div className="overflow-x-auto">
      <table className="tabular w-full whitespace-nowrap text-xs">
        <thead style={{ color: "var(--muted)" }}>
          <tr>
            <th className="py-1 text-left font-normal">Book</th>
            <th className="py-1 pl-3 text-right font-normal">Equity</th>
            <th className="py-1 pl-3 text-right font-normal">Return</th>
            <th className="py-1 pl-3 text-right font-normal">Positions</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(({ s, b }) => {
            return (
              <tr key={b.id} className="border-t" style={{ borderColor: "var(--grid)" }}>
                <td className="py-1.5" style={{ color: "var(--ink)" }}>
                  <span className="inline-flex items-center gap-1.5">
                    <svg width="16" height="8" aria-hidden>
                      <line x1="0" x2="16" y1="4" y2="4" stroke={s.color} strokeWidth="2" strokeDasharray={s.reference ? "4 3" : undefined} />
                    </svg>
                    {s.label}
                  </span>
                </td>
                <td className="py-1.5 pl-3 text-right" style={{ color: "var(--ink)" }}>{usd(b.equityUsd)}</td>
                <td className="py-1.5 pl-3 text-right font-semibold" style={{ color: "var(--ink)" }}>{pct(b.returnPct)}</td>
                <td className="py-1.5 pl-3 text-right" style={{ color: "var(--ink-2)" }}>{b.openPositions}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {/* The cost diagnostics stay one tap away. */}
      <details className="lp-details mt-3">
        <summary>Costs</summary>
        <table className="tabular w-full whitespace-nowrap text-xs">
          <thead style={{ color: "var(--muted)" }}>
            <tr>
              <th className="py-1 text-left font-normal">Book</th>
              <th className="py-1 pl-3 text-right font-normal">Fees</th>
              <th className="py-1 pl-3 text-right font-normal">Funding</th>
              <th className="py-1 pl-3 text-right font-normal" title="Traded notional per day ÷ starting capital">Turnover / day</th>
              <th className="py-1 pl-3 text-right font-normal">Trades</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(({ s, b }) => (
              <tr key={b.id} className="border-t" style={{ borderColor: "var(--grid)" }}>
                <td className="py-1.5" style={{ color: "var(--ink)" }}>{s.label}</td>
                <td className="py-1.5 pl-3 text-right" style={{ color: "var(--ink-2)" }}>{cost(b.feesUsd, b.startingEquityUsd)}</td>
                <td className="py-1.5 pl-3 text-right" style={{ color: "var(--ink-2)" }}>{cost(b.fundingUsd ?? 0, b.startingEquityUsd)}</td>
                <td className="py-1.5 pl-3 text-right" style={{ color: "var(--ink-2)" }} title={b.tradedSince ? `since ${new Date(b.tradedSince * 1000).toLocaleString()}` : undefined}>
                  {b.turnoverPerDay == null ? "—" : `${b.turnoverPerDay.toFixed(2)}×`}
                </td>
                <td className="py-1.5 pl-3 text-right" style={{ color: "var(--ink-2)" }}>{b.trades}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <div className="mt-2 text-xs" style={{ color: "var(--muted)" }}>
          Paper fills at mark ± slippage with taker fees and the live trading rules; funding at HL&apos;s hourly rate. Relative to starting capital.
        </div>
      </details>
    </div>
  );
}

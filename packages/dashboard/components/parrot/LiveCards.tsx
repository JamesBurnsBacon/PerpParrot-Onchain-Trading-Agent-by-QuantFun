"use client";
// The card the parrot's read-only Dashboard tools put on the page while it talks: run log, wallet drill-down
// or backtest. Presentation of code-built facts only; no controls that act on the account.
import { useEffect, useRef } from "react";
import { ExposureBars, Panel, Waiting } from "../Charts";
import { LineChart } from "../LineChart";
import { RunLog } from "../RunLog";
import { pct } from "../../lib/data";
import type { LiveCard } from "../../lib/parrot-reads";

const stamp = (ms: number) => new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

export function LiveCards({ card, onClose }: { card: LiveCard | null; onClose: () => void }) {
  const ref = useRef<HTMLElement>(null);
  // A new card scrolls into view (smoothly unless the visitor prefers reduced motion), so it lands while the parrot talks about it.
  useEffect(() => {
    if (!card) return;
    const calm = typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    ref.current?.scrollIntoView({ behavior: calm ? "auto" : "smooth", block: "nearest" });
  }, [card]);
  if (!card) return null;
  const close = <button type="button" className="parrot-live-card-close" onClick={onClose} aria-label="Close this card">×</button>;
  let body: React.ReactNode;
  let label: string;
  if (card.kind === "run") {
    label = "Run log";
    body = <Panel title="Run log" meta={<>{card.status ? (card.status.dryRun ? "dry run" : "live") : "status unavailable"}{card.status?.controls.paused ? " · paused" : ""} · as of {stamp(card.asOf)}</>} tone={4}>
      {card.runs.length ? <RunLog runs={card.runs} /> : <Waiting what="No runs yet" source="executor /runs" />}
      {card.exposures.length > 0 && <div className="mt-3"><p className="mb-1 text-xs" style={{ color: "var(--muted)" }}>Latest target exposures</p><ExposureBars exposures={card.exposures} /></div>}
    </Panel>;
  } else if (card.kind === "wallet") {
    label = `Wallet ${card.nickname}`;
    body = <Panel title={card.nickname} meta={<>{card.address.slice(0, 6)}…{card.address.slice(-4)}{card.picked === null ? "" : card.picked ? " · picked" : " · not picked"}</>} tone={1}>
      {card.lines.length || card.rationale ? <>
        <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs sm:grid-cols-3">
          {card.lines.map(l => <div key={l.label}><dt style={{ color: "var(--muted)" }}>{l.label}</dt><dd className="tabular" style={{ color: "var(--ink)" }}>{l.value}</dd></div>)}
        </dl>
        {card.rationale && <p className="mt-3 text-xs" style={{ color: "var(--ink-2)" }}>{card.rationale}</p>}
        <p className="mt-2 text-xs" style={{ color: "var(--muted)" }}>Past measurements, not a promise of returns.</p>
      </> : <Waiting what="No Dashboard record for this wallet" source="funnel finalists · pipeline" />}
    </Panel>;
  } else if (card.kind === "backtest") {
    label = "Backtest vs BTC";
    body = <Panel title="Backtest vs BTC" meta={`${card.window} · out of sample`} tone={3}>
      <LineChart series={card.series} format={v => pct(v, 1)} xFormat={t => new Date(t).toLocaleDateString([], { month: "short", day: "numeric" })} height={220} />
      <p className="mt-2 text-xs" style={{ color: "var(--muted)" }}>History, not a promise of returns.</p>
    </Panel>;
  } else {
    label = card.what;
    body = <Panel title={card.what} tone={5}><Waiting what={card.what} source="Dashboard data" /></Panel>;
  }
  return <section ref={ref} className="parrot-live-card min-w-0" aria-label={`Live card: ${label}`}>
    {close}
    <p className="sr-only" role="status">{label} is on screen.</p>
    {body}
  </section>;
}

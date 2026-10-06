"use client";
import { useState } from "react";
import type { FunnelArtifact } from "../../shared/dashboard";

type Finalist = NonNullable<FunnelArtifact["finalists"]>[number];

const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;

// Finalists ranked by score; picked ones carry the series color and a check. Click a row for the rationale.
export function Finalists({ finalists }: { finalists: Finalist[] }) {
  const [open, setOpen] = useState<string | null>(null);
  const rows = [...finalists].sort((a, b) => b.score - a.score);
  const max = Math.max(...rows.map((r) => Math.abs(r.score)), 1e-9);
  const picked = rows.filter((r) => r.picked).length;
  return (
    <div>
      <div className="mb-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs" style={{ color: "var(--ink-2)" }}>
        <span className="inline-flex items-center gap-1.5 whitespace-nowrap"><span className="inline-block h-2.5 w-2.5 rounded-sm" style={{ background: "var(--series-1)" }} />Picked {picked}</span>
        <span className="inline-flex items-center gap-1.5 whitespace-nowrap"><span className="inline-block h-2.5 w-2.5 rounded-sm" style={{ background: "var(--axis)" }} />Not picked {rows.length - picked}</span>
        <span style={{ color: "var(--muted)" }}>bar = score · click a row for why</span>
      </div>
      <ul className="max-h-[26rem] overflow-auto">
        {rows.map((r, i) => {
          const expanded = open === r.address;
          return (
            <li key={r.address} className="border-t first:border-t-0" style={{ borderColor: "var(--grid)" }}>
              <button
                className="grid w-full grid-cols-[1.5rem_6.5rem_4.5rem_1fr_3.5rem_1rem] items-center gap-2 py-1.5 text-left text-xs"
                aria-expanded={expanded}
                onClick={() => setOpen(expanded ? null : r.address)}
              >
                <span className="tabular" style={{ color: "var(--muted)" }}>{i + 1}</span>
                <span className="font-mono" style={{ color: "var(--ink)" }}>{short(r.address)}</span>
                <span className="truncate" style={{ color: "var(--ink-2)" }}>{r.kind}</span>
                <span className="h-3">
                  <span
                    className="block h-3 rounded-[4px]"
                    style={{ width: `${Math.max(2, (Math.abs(r.score) / max) * 100)}%`, background: r.picked ? "var(--series-1)" : "var(--axis)" }}
                  />
                </span>
                <span className="tabular text-right font-semibold" style={{ color: "var(--ink)" }}>
                  {r.score.toLocaleString(undefined, { maximumSignificantDigits: 3 })}
                </span>
                <span style={{ color: "var(--series-1)" }} aria-label={r.picked ? "picked" : "not picked"}>{r.picked ? "✓" : ""}</span>
              </button>
              {expanded && (
                <div className="pb-2 pl-8 pr-2 text-xs leading-relaxed" style={{ color: "var(--ink-2)" }}>
                  {r.rationale ?? <span style={{ color: "var(--muted)" }}>No rationale recorded.</span>}{" "}
                  <a className="underline underline-offset-2" style={{ color: "var(--muted)" }} href={`https://app.hyperliquid.xyz/explorer/address/${r.address}`} target="_blank" rel="noreferrer">
                    explorer ↗
                  </a>
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

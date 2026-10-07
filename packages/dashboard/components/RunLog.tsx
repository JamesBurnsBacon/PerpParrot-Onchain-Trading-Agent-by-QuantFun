"use client";
import { useState } from "react";
import { RUN_STATUS } from "./Charts";
import { ordersOf, runTime, time, type Run } from "../lib/data";

const short = (h: string) => `${h.slice(0, 10)}…${h.slice(-6)}`;

const download = (r: Run) => {
  const blob = new Blob([JSON.stringify({ runId: r.runId, ...r.evidence }, null, 2)], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `${r.runId}.json`;
  a.click();
  URL.revokeObjectURL(a.href);
};

// Latest runs with what each traded toward: the hash of the positions snapshot the targets came
// from (anyone can fetch the snapshot and re-hash it) and the targets, downloadable.
export function RunLog({ runs }: { runs: Run[] }) {
  const [copied, setCopied] = useState<string | null>(null);
  const rows = runs.filter((r) => r.kind === "mirror");
  const copy = (id: string) => navigator.clipboard?.writeText(id).then(() => setCopied(id), () => {});
  return (
    <div className="overflow-x-auto">
      <table className="tabular w-full whitespace-nowrap text-xs">
        <thead style={{ color: "var(--muted)" }}>
          <tr>
            <th className="py-1 text-left font-normal">Run</th>
            <th className="py-1 text-left font-normal">Status</th>
            <th className="py-1 pl-3 text-right font-normal">Orders</th>
            <th className="py-1 pl-3 text-right font-normal" title="Target exposures the run traded toward">Targets</th>
            <th className="py-1" />
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => {
            const s = RUN_STATUS[r.status];
            return (
              <tr key={r.id} className="border-t" style={{ borderColor: "var(--grid)" }}>
                <td className="py-1.5" style={{ color: "var(--ink)" }}>{time(runTime(r))}</td>
                <td className="py-1.5" style={{ color: "var(--ink-2)" }}>
                  <span style={{ color: s.color }}>{s.icon}</span> {s.label}
                </td>
                <td className="py-1.5 text-right">{ordersOf(r)}</td>
                <td className="py-1.5 text-right">{r.evidence?.exposures.length ?? "—"}</td>
                <td className="py-1.5 pl-3 text-right">
                  {r.evidence && (
                    // The snapshot hash stays one tap away: copy it, or download the whole evidence record.
                    <span className="inline-flex items-center gap-2">
                      <button aria-label={`Copy snapshot hash ${short(r.evidence.snapshotHash)}`} title={copied === r.evidence.snapshotHash ? "Copied" : `Copy snapshot hash ${short(r.evidence.snapshotHash)}`} style={{ color: "var(--muted)" }} onClick={() => copy(r.evidence!.snapshotHash)}>
                        {copied === r.evidence.snapshotHash ? "✓" : "⧉"}
                      </button>
                      <button aria-label={`Download ${r.runId} evidence`} title="Download evidence.json" style={{ color: "var(--muted)" }} onClick={() => download(r)}>
                        ↓
                      </button>
                    </span>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

"use client";
import { useState } from "react";
import { RUN_STATUS } from "./Charts";
import { ordersOf, runTime, time, type Run } from "../lib/data";

const short = (h: string) => `${h.slice(0, 10)}…${h.slice(-6)}`;

const download = (r: Run) => {
  const blob = new Blob([JSON.stringify({ runId: r.runId, id: r.id, ...r.envelope }, null, 2)], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `${r.runId}.json`;
  a.click();
  URL.revokeObjectURL(a.href);
};

// Latest runs with their DON-signed reports, downloadable so anyone can re-verify them.
export function RunLog({ runs }: { runs: Run[] }) {
  const [copied, setCopied] = useState<string | null>(null);
  const rows = runs.filter((r) => r.kind === "report");
  const copy = (id: string) => navigator.clipboard?.writeText(id).then(() => setCopied(id), () => {});
  return (
    <div className="overflow-x-auto">
      <table className="tabular w-full whitespace-nowrap text-xs">
        <thead style={{ color: "var(--muted)" }}>
          <tr>
            <th className="py-1 text-left font-normal">Run</th>
            <th className="py-1 text-left font-normal">Status</th>
            <th className="py-1 pl-3 text-right font-normal">Orders</th>
            <th className="py-1 pl-4 text-left font-normal">Report ID</th>
            <th className="py-1 pl-3 text-right font-normal" title="DON signatures on the report">Sigs</th>
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
                  <span style={{ color: s.color }}>{s.icon}</span> {s.label}{r.dryRun ? " · dry" : ""}
                </td>
                <td className="py-1.5 text-right">{ordersOf(r)}</td>
                <td className="py-1.5 pl-4 font-mono">
                  <button className="hover:underline" title="Copy" onClick={() => copy(r.id)}>{short(r.id)}</button>
                  {copied === r.id && <span className="ml-2" style={{ color: "var(--muted)" }}>copied</span>}
                </td>
                <td className="py-1.5 text-right">{r.envelope?.signatures.length ?? "—"}</td>
                <td className="py-1.5 pl-3 text-right">
                  {r.envelope && (
                    <button className="underline underline-offset-2" style={{ color: "var(--muted)" }} onClick={() => download(r)}>
                      report.json
                    </button>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <div className="mt-2 text-xs" style={{ color: "var(--muted)" }}>
        Verify a run: <code className="font-mono">bun run scripts/verify-run.ts --run mirror-…</code> in <code className="font-mono">packages/executor</code>
      </div>
    </div>
  );
}

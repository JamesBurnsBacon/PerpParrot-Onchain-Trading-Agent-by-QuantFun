import { Funnel, Panel, Waiting } from "../Charts";
import { LineChart } from "../LineChart";
import { performanceSeries, pct, stamp } from "../../lib/data";
import { Badge } from "./Badge";
import { useVerification } from "./useVerification";

export function VerifyPanel({ demo, previewHash, onExecute, canExecute }: { demo: boolean; previewHash?: string; onExecute: () => void; canExecute: boolean }) {
  const data = useVerification(!demo);
  const series = performanceSeries(data.paper, null);
  return <div className="space-y-4">
    <Panel title="Selection funnel" meta={demo ? <Badge kind="CACHED DEMO" /> : undefined}>
      <p className="mb-4 text-xs" style={{ color: "var(--ink-2)" }}>Published selection artifact; not a verification of this conversation.</p>
      {data.funnel?.steps.length ? <Funnel steps={data.funnel.steps} /> : <Waiting what="Funnel not published yet" source={demo ? "Cached demo includes no verification evidence" : "dashboard_artifacts · funnel"} />}
    </Panel>
    <Panel title="Paper-book performance" meta={demo ? <Badge kind="CACHED DEMO" /> : undefined}>
      <p className="mb-4 text-xs" style={{ color: "var(--ink-2)" }}>Existing simulated books, not a forecast for your strategy.</p>
      {series.length ? <LineChart series={series} format={v => pct(v)} xFormat={stamp(series)} height={230} /> : <Waiting what="Paper curves not published yet" source={demo ? "Cached demo includes no performance evidence" : "backend /paper"} />}
    </Panel>
    <Panel title="Checkable" meta={<span className="parrot-eyebrow">EVIDENCE, NOT PROMISES</span>}>
      <p className="text-sm leading-relaxed">A committed hash identifies the exact data a signed report commits to. No committed report hash is provided by these endpoints, so none is verified here.</p>
      <p className="mt-3 text-sm leading-relaxed">A real signed report can be re-verified with the verify-run script. See docs/VERIFIABILITY.md.</p>
      <p className="mt-3 text-sm" style={{ color: "var(--ink-2)" }}>The preview hash identifies a pending request; it is not a signed report.</p>
      {previewHash && <p className="parrot-hash mt-3">{previewHash}</p>}
    </Panel>
    <button className="parrot-button parrot-button--primary w-full" disabled={!canExecute} onClick={onExecute}>Review the request <span aria-hidden="true">→</span></button>
  </div>;
}

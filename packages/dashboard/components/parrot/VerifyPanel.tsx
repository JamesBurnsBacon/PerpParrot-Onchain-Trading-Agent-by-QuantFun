// Read-only funnel and paper evidence panel used by StepRail.
// Existing paper curves are not returns for the visitor shortlist or proof of execution.
import { Panel, Waiting } from "../Charts";
import { LineChart } from "../LineChart";
import { performanceSeries, pct, stamp } from "../../lib/data";
import { Badge } from "./Badge";
import { useVerification } from "./useVerification";

// Own funnel bars: the Dashboard's `Funnel` was removed from Charts, and this page keeps its look separate from the Dashboard's.
// Square-root widths keep the last stages (a handful of picks) visible next to tens of thousands of addresses.
function FunnelSteps({ steps }: { steps: { stage: string; label: string; count: number }[] }) {
  const max = Math.max(...steps.map(s => s.count), 1);
  return <ol className="space-y-1" aria-label="Selection funnel">
    {steps.map(s => <li key={s.stage} className="grid grid-cols-[7.5rem_1fr_4rem] items-center gap-2 text-xs">
      <span className="text-right" style={{ color: "var(--ink-2)" }}>{s.label}</span>
      <span className="block h-4 rounded" style={{ width: `${Math.max(1, (Math.sqrt(s.count) / Math.sqrt(max)) * 100)}%`, background: "var(--series-1)" }} />
      <span className="tabular" style={{ color: "var(--ink)" }}>{s.count.toLocaleString()}</span>
    </li>)}
  </ol>;
}

export function VerifyPanel({ demo, previewHash, onExecute, canExecute }: { demo: boolean; previewHash?: string; onExecute: () => void; canExecute: boolean }) {
  const data = useVerification(!demo);
  const series = performanceSeries(data.paper, null, null);
  return <div className="space-y-4">
    <Panel title="Selection funnel" meta={demo ? <Badge kind="CACHED DEMO" /> : undefined}>
      <p className="mb-4 text-xs" style={{ color: "var(--ink-2)" }}>Published selection artifact; not a verification of this conversation.</p>
      {data.funnel?.steps.length ? <FunnelSteps steps={data.funnel.steps} /> : <Waiting what="Funnel not published yet" source={demo ? "Cached demo includes no verification evidence" : "dashboard_artifacts · funnel"} />}
    </Panel>
    <Panel title="Paper-book performance" meta={demo ? <Badge kind="CACHED DEMO" /> : undefined}>
      <p className="mb-4 text-xs" style={{ color: "var(--ink-2)" }}>Existing simulated books, not a forecast for your strategy.</p>
      {series.length ? <LineChart series={series} format={v => pct(v)} xFormat={stamp(series)} height={230} /> : <Waiting what="Paper curves not published yet" source={demo ? "Cached demo includes no performance evidence" : "backend /paper"} />}
    </Panel>
    <Panel title="Checkable" meta={<span className="parrot-eyebrow">EVIDENCE, NOT PROMISES</span>}>
      <p className="text-sm leading-relaxed">The preview hash identifies the pending request and its evidence. It does not authorize trading.</p>
      <p className="mt-3 text-sm leading-relaxed">An operator must review and freeze separately. Nothing is applied or traded.</p>
      <p className="mt-3 text-sm" style={{ color: "var(--ink-2)" }}>The saved policy is the base policy in SIMULATION mode; wallet preferences do not change it.</p>
      {previewHash && <p className="parrot-hash mt-3">{previewHash}</p>}
    </Panel>
    <button className="parrot-button parrot-button--primary w-full" disabled={!canExecute} onClick={onExecute}>Review the request <span aria-hidden="true">→</span></button>
  </div>;
}

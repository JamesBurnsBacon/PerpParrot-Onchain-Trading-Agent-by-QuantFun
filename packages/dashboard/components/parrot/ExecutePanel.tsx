import { Panel, StatTile } from "../Charts";
import { describeError, type ChatResponse, type PreviewResponse } from "../../lib/parrot";
import { Badge } from "./Badge";
import { HoldButton } from "./HoldButton";
import type { Failure } from "./api";

export function ExecutePanel({ chat, demo, result, busy, failure, onConfirm, executionDisabled }: {
  chat: ChatResponse; demo: boolean; result: PreviewResponse | null; busy: boolean;
  failure: Failure | null; onConfirm: () => void; executionDisabled: boolean;
}) {
  const eligible = result?.preview.liveEligible ?? chat.policy.liveEligible;
  const bucket = result?.preview.policy.bucket;
  return <div className="space-y-4">
    <Panel title="A request. Then a human review." meta={demo ? <Badge kind="CACHED DEMO" /> : <span className="parrot-eyebrow">03 / EXECUTE</span>}>
      <p className="text-sm leading-relaxed" style={{ color: "var(--ink-2)" }}>Save a bounded strategy for an operator to review and freeze. This page only creates a PENDING request.</p>
      <div className="my-5 grid grid-cols-2 gap-3">
        <StatTile label="Bucket" value={typeof bucket === "string" ? bucket : chat.intent.riskStyle.toUpperCase()} />
        <StatTile label="Sources" value={String(result?.preview.sources.length ?? chat.shortlist.addresses.length)} />
      </div>
      <span className="parrot-chip font-bold">{eligible ? "eligible for live" : "paper only"}</span>
      <p className="mt-4 text-xs font-bold uppercase tracking-wider">Preview hash</p>
      <p className="parrot-hash mt-2">{result?.preview.previewHash ?? "Available after the request is saved."}</p>
      <div className="parrot-rule my-5"><p className="text-sm font-semibold leading-relaxed">What the parrot cannot do: place orders, hold keys, change a frozen set</p></div>
      {result ? <div className="parrot-success" role="status">
        <span className="parrot-eyebrow">{demo ? "CACHED DEMO · PENDING" : "PENDING"}</span>
        {demo && <p className="mt-2 text-sm font-bold">Simulated result only. Nothing was saved to the server.</p>}
        <p className="mt-2 font-bold break-words">Request {result.requestId} saved. Awaiting operator freeze.</p>
        {result.preview.paperOnly && <p className="mt-2 text-sm">paper book request</p>}
        <p className="parrot-hash mt-3">{result.preview.previewHash}</p>
      </div> : <HoldButton disabled={busy || executionDisabled || !chat.shortlist.addresses.length} onConfirm={onConfirm} />}
      {executionDisabled && !result && <p className="mt-3 text-center text-xs" style={{ color: "var(--ink-2)" }}>End voice to lock this strategy.</p>}
      {busy && <p role="status" className="mt-3 text-sm">Saving the pending request…</p>}
      {failure && <div className="parrot-error mt-4" role="alert"><p>{describeError(failure.code, failure.retryAfterSec)}</p></div>}
      {result && <details className="parrot-details mt-4"><summary>Show preview JSON</summary><pre>{JSON.stringify(result, null, 2)}</pre></details>}
    </Panel>
    <div className="parrot-terminal"><span aria-hidden="true">&gt; </span>intent → code limits → pending request<br /><span className="opacity-80">Operator freeze and a signed report are separate steps.</span></div>
  </div>;
}

// Presentation only. HoldButton and the caller retain all confirmation guards.
import type { ChatResponse, PreviewResponse } from "../../lib/parrot";
import { describeError } from "../../lib/parrot";
import { Badge } from "./Badge";
import { HoldButton } from "./HoldButton";
import { CountUp, DryBird, SavedStamp } from "./StageBits";
import type { Failure } from "./api";

export function ExecutePanel({ chat, demo, result, busy, failure, onConfirm, executionDisabled }: {
  chat: ChatResponse; demo: boolean; result: PreviewResponse | null; busy: boolean;
  failure: Failure | null; onConfirm: () => void; executionDisabled: boolean;
}) {
  return <section className="execute-stage" aria-label="Save pending strategy">
    {demo && <Badge kind="CACHED DEMO" />}
    {result ? <SavedStamp id={result.requestId} hash={result.preview.previewHash} demo={demo} /> : <>
      <DryBird /><h2>LOCK IT?</h2>
      <div className="strategy-chips"><span>{chat.intent.riskStyle}</span><span><CountUp value={chat.shortlist.addresses.length} /> birds</span></div>
      <HoldButton chat={chat} disabled={busy || executionDisabled || !chat.shortlist.addresses.length} onConfirm={onConfirm} />
      {executionDisabled && <p role="status">End voice first</p>}
      {busy && <p role="status">{demo ? "Simulating…" : "Saving…"}</p>}
    </>}
    <p className="honesty-line">dry run - nothing is sent</p>
    {failure && <p className="stage-error" role="alert"><span aria-hidden="true">Try again</span><span className="sr-only">{describeError(failure.code, failure.retryAfterSec)}</span></p>}
  </section>;
}

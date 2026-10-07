// Select, Verify and pending-request steps composed by the Parrot page.
// The Execute label must never imply that confirming places orders.
import type { ChatResponse, PreviewResponse } from "../../lib/parrot";
import { SelectPanel } from "./SelectPanel";
import { VerifyPanel } from "./VerifyPanel";
import { ExecutePanel } from "./ExecutePanel";
import type { Failure } from "./api";

export type Step = 0 | 1 | 2;
export function StepRail({ chat, demo, step, setStep, preview, busy, failure, onConfirm, executionDisabled }: {
  chat: ChatResponse; demo: boolean; step: Step; setStep: (step: Step) => void;
  preview: PreviewResponse | null; busy: boolean; failure: Failure | null; onConfirm: () => void; executionDisabled: boolean;
}) {
  const unlocked = [true, true, !!chat.shortlist.addresses.length];
  return <aside className="parrot-rail min-w-0" aria-label="Strategy steps">
    <nav className="parrot-stepper" aria-label="Strategy progress">{(["Select", "Verify", "Execute"] as const).map((label, i) => <button
      key={label} type="button" aria-current={step === i ? "step" : undefined} disabled={!unlocked[i] || busy}
      className={step === i ? "is-current" : ""} onClick={() => setStep(i as Step)} aria-controls="parrot-step-panel">
      <span className="parrot-step-number">{i + 1}</span><span>{label}</span>
    </button>)}</nav>
    <div id="parrot-step-panel" className="mt-5">
      <div hidden={step !== 0}><SelectPanel chat={chat} demo={demo} onVerify={() => setStep(1)} /></div>
      {step === 1 ?
        <VerifyPanel demo={demo} previewHash={preview?.preview.previewHash} canExecute={unlocked[2]} onExecute={() => setStep(2)} /> : step === 2 ?
        <ExecutePanel chat={chat} demo={demo} result={preview} busy={busy} failure={failure} onConfirm={onConfirm} executionDisabled={executionDisabled} /> : null}
    </div>
  </aside>;
}

import { Panel } from "../Charts";
import type { ChatResponse, PreviewResponse } from "../../lib/parrot";
import { SelectPanel } from "./SelectPanel";
import { VerifyPanel } from "./VerifyPanel";
import { ExecutePanel } from "./ExecutePanel";
import type { Failure } from "./api";

export type Step = 0 | 1 | 2;
export function StepRail({ chat, demo, step, setStep, preview, busy, failure, onConfirm, onDemo }: {
  chat: ChatResponse | null; demo: boolean; step: Step; setStep: (step: Step) => void;
  preview: PreviewResponse | null; busy: boolean; failure: Failure | null; onConfirm: () => void; onDemo: () => void;
}) {
  const unlocked = [!!chat, !!chat, !!chat?.shortlist.addresses.length];
  return <aside className="parrot-rail min-w-0" aria-label="Strategy steps">
    <nav className="parrot-stepper" aria-label="Strategy progress">{(["Select", "Verify", "Execute"] as const).map((label, i) => <button
      key={label} type="button" aria-current={step === i ? "step" : undefined} disabled={!unlocked[i] || busy}
      className={step === i ? "is-current" : ""} onClick={() => setStep(i as Step)} aria-controls="parrot-step-panel">
      <span className="parrot-step-number">{i + 1}</span><span>{label}</span>
    </button>)}</nav>
    <div id="parrot-step-panel" className="mt-5">
      {!chat ? <Panel title="A little conversation. A checkable strategy.">
        <p className="mt-2 text-sm leading-relaxed" style={{ color: "var(--ink-2)" }}>Tell the parrot what you have in mind. Your first reply opens the steps below.</p>
        <ol className="parrot-intro-list">
          <li><span>01</span><div><h3>Find your flock</h3><p>Code shortlists wallets within the policy limits.</p></div></li>
          <li><span>02</span><div><h3>See the evidence</h3><p>Inspect published selection data and paper books.</p></div></li>
          <li><span>03</span><div><h3>Make a pending request</h3><p>An operator must review and freeze the strategy.</p></div></li>
        </ol>
        <div className="parrot-terminal"><span aria-hidden="true">&gt; </span>Big ideas. Bounded by code.<br /><span className="opacity-80">The beak doesn't hold the keys.</span></div>
      </Panel> : step === 0 ? <SelectPanel chat={chat} demo={demo} onVerify={() => setStep(1)} /> : step === 1 ?
        <VerifyPanel demo={demo} previewHash={preview?.preview.previewHash} canExecute={unlocked[2]} onExecute={() => setStep(2)} /> :
        <ExecutePanel chat={chat} demo={demo} result={preview} busy={busy} failure={failure} onConfirm={onConfirm} onDemo={onDemo} />}
    </div>
  </aside>;
}

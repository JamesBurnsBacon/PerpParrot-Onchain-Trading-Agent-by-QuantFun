"use client";
import { useEffect, useRef, useState } from "react";
import type { ReceiptRow } from "../../lib/parrot-judge-queue";
import { settle, STAMPS } from "../../lib/parrot-receipts";
import type { ReceiptStatus } from "./useSentenceReceipts";
import { DecisionsDrawer } from "./DecisionsDrawer";

export type CompactReceiptProps = { active: boolean; status: ReceiptStatus; rows: ReceiptRow[]; latest?: ReceiptRow; calls: number; cost: number };
export function CompactReceipt({ active, status, rows, latest, calls, cost }: CompactReceiptProps) {
  const [selection, setSelection] = useState<{ row: ReceiptRow; opener: HTMLButtonElement }>();
  const [announcement, setAnnouncement] = useState("");
  const lastAnnouncement = useRef(-Infinity);
  const visible = active && status !== "off" && !!latest;
  const decision = latest?.decision, banter = decision && decision.statesAFact < .5;
  const stamp = decision && !banter ? STAMPS[settle(decision)] : undefined;
  const state = status === "paused" ? "Receipts paused" : latest?.state === "checking" ? "Checking…" : "Not checked";
  useEffect(() => {
    if (!visible || status !== "ready" || !stamp) return;
    const timer = setTimeout(() => {
      lastAnnouncement.current = performance.now();
      setAnnouncement(`${latest!.claim} ${stamp}`);
    }, Math.max(0, 1500 - (performance.now() - lastAnnouncement.current)));
    return () => clearTimeout(timer);
  }, [visible, status, latest?.id, stamp]);
  useEffect(() => { if (!visible) { setSelection(undefined); setAnnouncement(""); } }, [visible]);
  if (!visible) return null;
  const open = (opener: HTMLButtonElement) => setSelection({ row: latest, opener });
  return <>
    <div className="compact-receipt">
      <button type="button" className="compact-receipt-header" aria-haspopup="dialog" aria-controls="parrot-decisions-drawer" onClick={e => open(e.currentTarget)}>Audited by OpenAI Decisions</button>
      <button type="button" className="compact-receipt-row" aria-haspopup="dialog" aria-controls="parrot-decisions-drawer" onClick={e => open(e.currentTarget)}>
        <span className="compact-receipt-sentence">{latest.claim}</span>
        {status === "paused" || !decision ? <span className="compact-receipt-state">{state}</span> : banter ? <span className="compact-receipt-state">banter</span> : <>
          <strong className="compact-receipt-stamp" data-relation={settle(decision)}>{stamp}</strong>
          <span className="compact-receipt-grounding"><span className="sr-only">Grounding </span>{Math.round(decision.supported * 100)}%
            <span className="compact-receipt-meter" aria-hidden="true"><i style={{ width: `${decision.supported * 100}%` }} /></span>
          </span>
        </>}
      </button>
    </div>
    <span className="sr-only" aria-live="polite" aria-atomic="true">{announcement}</span>
    {selection && <DecisionsDrawer rows={rows} initial={selection.row} calls={calls} cost={cost} opener={selection.opener} onClose={() => setSelection(undefined)} />}
  </>;
}

"use client";
import { useEffect, useRef, useState } from "react";
import type { ReceiptRow } from "../../lib/parrot-judge-queue";
import { DecisionsLens } from "./DecisionsLens";

export function DecisionsDrawer({ rows, initial, calls, cost, opener, onClose }: {
  rows: ReceiptRow[]; initial: ReceiptRow; calls: number; cost: number; opener: HTMLButtonElement; onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  // Keep the selection and its evidence stable as new speech arrives or old rows are evicted.
  const [selected, setSelected] = useState(initial);
  const row = rows.find(r => r.id === selected.id) ?? selected;
  const choices = rows.filter(r => r.decision).slice(0, 10);
  if (!choices.some(r => r.id === row.id)) choices.unshift(row);
  useEffect(() => {
    const node = dialog.current!;
    node.showModal(); // Native top layer supplies inert background, focus containment and Escape.
    // The native `close` event is asynchronous: React StrictMode's dev-only effect replay closes and reopens the dialog,
    // so a stale event can arrive while it is open again. The onClose handler below therefore ignores it unless the dialog is closed.
    return () => { node.close(); if (opener.isConnected) opener.focus(); };
  }, [opener]);
  return <dialog ref={dialog} id="parrot-decisions-drawer" className="decisions-drawer" aria-modal="true" aria-labelledby="parrot-decisions-title" onClose={() => { if (!dialog.current?.open) onClose(); }}>
    <header><h2 id="parrot-decisions-title">Decisions Lens</h2><button type="button" autoFocus onClick={() => dialog.current?.close()}>Close</button></header>
    <label>Sentence<select value={row.id} onChange={event => setSelected(choices.find(r => r.id === Number(event.target.value))!)}>
      {choices.map(r => <option key={r.id} value={r.id}>{r.claim}</option>)}
    </select></label>
    <p className="decisions-sentence">{row.claim}</p>
    <h3>Receipt of this turn</h3><pre>{row.facts || "No facts yet"}</pre>
    <DecisionsLens verdict={row.decision} live={row.decision} cached={false} roundTrip={row.roundTrip} />
    <p>Visit: {calls} calls · ${cost.toFixed(8)} estimated cost of confirmed results. Failed or aborted attempts may cost extra.</p>
  </dialog>;
}

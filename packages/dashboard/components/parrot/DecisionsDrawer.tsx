"use client";
import { useEffect, useRef, useState } from "react";
import type { ReceiptRow } from "../../lib/parrot-judge-queue";
import { settle, STAMPS } from "../../lib/parrot-receipts";
import { OpenAIMark } from "./OpenAIMark";
import { Icon } from "./StageBits";

// The exact sentence and turn facts are shown in full (small type), without paging, a JSON viewer or scrolling.
export function ReceiptText({ text, label }: { text: string; label: string }) {
  const display = text.replace(/\s+/g, " ").trim();
  return <section className="receipt-text"><h3>{label}</h3><p>{display}</p></section>;
}

export function DecisionsDrawer({ rows, initial, calls, cost, opener, onClose }: {
  rows: ReceiptRow[]; initial: ReceiptRow; calls: number; cost: number; opener: HTMLButtonElement; onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [selected, setSelected] = useState(initial);
  const latest = useRef(selected);
  const found = rows.find(r => r.id === selected.id);
  if (found) latest.current = found;
  const row = found ?? latest.current;
  const choices = rows.filter(r => r.decision).slice(0, 10);
  if (!choices.some(r => r.id === row.id)) choices.unshift(row);
  useEffect(() => {
    const node = dialog.current!;
    node.showModal();
    return () => { node.close(); if (opener.isConnected) opener.focus(); };
  }, [opener]);
  const d = row.decision;
  const verdict = d ? d.statesAFact < .5 ? "banter" : STAMPS[settle(d)] : "Not checked";
  return <dialog ref={dialog} id="parrot-decisions-drawer" className="decisions-drawer" aria-modal="true" aria-labelledby="parrot-decisions-title" onClose={() => { if (!dialog.current?.open) onClose(); }}>
    <header><h2 id="parrot-decisions-title"><OpenAIMark />Decisions</h2><button type="button" autoFocus aria-label="Close Decisions" onClick={() => dialog.current?.close()}><Icon kind="close" /></button></header>
    <label className="receipt-select">Sentence<select value={row.id} onChange={event => setSelected(choices.find(r => r.id === Number(event.target.value))!)}>
      {choices.map(r => <option key={r.id} value={r.id}>{r.claim}</option>)}
    </select></label>
    <ReceiptText key={`claim-${row.id}`} text={row.claim} label="The claim" />
    <strong className="drawer-verdict" aria-label={verdict}>{verdict === "NOT ON THE RECEIPT" ? "NO EVIDENCE" : verdict}</strong>
    <ReceiptText key={`facts-${row.id}`} text={row.facts || "No facts yet"} label="Turn facts" />
    <dl className="receipt-numbers"><div><dt>Grounding</dt><dd>{d ? `${Math.round(d.supported * 100)}%` : "—"}</dd></div><div><dt>Round trip</dt><dd>{row.roundTrip == null ? "—" : `${Math.round(row.roundTrip)} ms`}</dd></div><div><dt>Calls</dt><dd>{calls}</dd></div></dl>
    <small title={`Estimated cost of confirmed results: $${cost.toFixed(8)}. Failed or aborted attempts may cost extra.`}>Words, not markets</small>
  </dialog>;
}

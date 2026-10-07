"use client";
import { useEffect, useRef, useState } from "react";
import { RECEIPT, claimText, type Decision } from "../../../../shared/receipt";
import { Badge } from "../../../components/parrot/Badge";
import { ParrotAvatar } from "../../../components/parrot/ParrotAvatar";
import { ParrotEffectsProvider, useParrotEffects } from "../../../components/parrot/ParrotEffects";
import { DecisionsLens } from "../../../components/parrot/DecisionsLens";
import { backendFetch } from "../../../components/parrot/api";
import { PRESETS, CACHED, STAMPS, CAPTIONS, isDecision, settle, disagrees, type Verdict } from "../../../lib/parrot-receipts";
export default function ReceiptClient() { return <ParrotEffectsProvider><ReceiptContent /></ParrotEffectsProvider>; }
export function ReceiptContent({ initialCached = false }: { initialCached?: boolean }) {
  const fx = useParrotEffects(), request = useRef<AbortController | null>(null), stampTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const [claim, setClaim] = useState(PRESETS[0]), [judged, setJudged] = useState("");
  const [verdict, setVerdict] = useState<Verdict>(), [live, setLive] = useState<Decision>();
  const [cached, setCached] = useState(initialCached), [reason, setReason] = useState("Jury unavailable; choose a preset to play the cached demo.");
  const [busy, setBusy] = useState(false), [roundTrip, setRoundTrip] = useState<number>();
  const [visit, setVisit] = useState({ calls: 0, cost: 0 }), [serial, setSerial] = useState(0);
  useEffect(() => () => { request.current?.abort(); clearTimeout(stampTimer.current); }, []);
  function cue(kind: "tick" | "sprinkle" | "nope" | "bubble" | "tada") {
    if (!document.hidden && fx.sound && fx.sfx.enabled) fx.sfx.kit().cue({ kind, at: 0, pitch: 0 });
  }
  function finish(text: string, result: Verdict) {
    setJudged(text); setVerdict(result); setSerial(n => n + 1);
    const outcome = settle(result);
    cue(outcome === "faithful" ? "sprinkle" : outcome === "contradicted" ? "nope" : "bubble");
    if (outcome === "faithful") stampTimer.current = setTimeout(() => cue("tada"), 800);
  }
  function select(text: string) { clearTimeout(stampTimer.current); fx.sfx.cancel(); setClaim(text); setVerdict(undefined); setLive(undefined); setJudged(""); }
  async function judge() {
    if (request.current) return;
    let text: string; try { text = claimText(claim); } catch { return; }
    clearTimeout(stampTimer.current); fx.sfx.cancel();
    const controller = new AbortController(); request.current = controller;
    setBusy(true); setVerdict(undefined); setLive(undefined); setJudged(text);
    let unavailable = "Jury unavailable.";
    try {
      await fx.sfx.unlock(); if (controller.signal.aborted) return; cue("tick");
      if (cached) { const index = PRESETS.indexOf(text); if (index >= 0) finish(text, CACHED[index]); return; }
      const start = performance.now();
      const response = await backendFetch("/decide/receipt", { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ claim: text }), signal: AbortSignal.any([controller.signal, AbortSignal.timeout(10_000)]) });
      if (!response.ok) { unavailable = response.status === 503 ? "Jury is resting." : response.status === 429 ? "Jury's call allowance is used up." : unavailable; throw new Error(); }
      const value: unknown = await response.json();
      if (!isDecision(value, { claim: text }) || JSON.parse(value.request.input).claim !== text) throw new Error("Jury returned an unfamiliar result.");
      if (controller.signal.aborted) return;
      setRoundTrip(performance.now() - start); setLive(value);
      setVisit(v => ({ calls: v.calls + 1, cost: v.cost + value.costUsd })); finish(text, value);
    } catch {
      if (controller.signal.aborted) return;
      setCached(true); setReason(`${unavailable} Free text is off; choose a cached preset.`);
      const index = PRESETS.indexOf(text); if (index >= 0) finish(text, CACHED[index]);
    } finally { controller.abort(); if (request.current === controller) { request.current = null; setBusy(false); } }
  }
  let valid = false; try { claimText(claim); valid = true; } catch {}
  return <main className={`parrot-page receipt-page ${fx.quiet ? "receipt-quiet" : ""}`}>
    <header className="receipt-header"><a href="/parrot">← Back to the nest</a><a href="/parrot/receipts/live">Judge the Parrot live →</a>
      <small title="Validated API results only. Failed attempts may still be billed.">Decisions calls this visit: {visit.calls} · ${visit.cost.toFixed(8)}<br />Confirmed results · estimated cost; failed calls may cost extra</small></header>
    <h1>Receipt Guillotine <span aria-hidden="true">✂</span></h1><p className="receipt-subtitle">Big beak. Small print. Bring the receipt.</p>
    <section className="receipt-paper" aria-label="Sample receipt"><Badge kind="SAMPLE DATA" /><h2>RECEIPT № 001</h2><pre>{RECEIPT}</pre></section>
    <section className="receipt-stage" aria-label="Parrot claim"><div className={busy ? "receipt-lean" : ""}><ParrotAvatar state={busy ? "thinking" : "idle"} /></div>
      <div className="receipt-speech"><p>“{claim}”</p><strong aria-live="polite">{busy ? "Hmm...! Let me check my beak's paperwork." : verdict ? CAPTIONS[settle(verdict)] : "Squawk! Pick a sentence. I'll face the paperwork."}</strong></div></section>
    <div className="receipt-presets" aria-label="Preset claims">{PRESETS.map(text => <button className="parrot-button" key={text} disabled={busy} aria-pressed={claim === text} onClick={() => select(text)}>{text}</button>)}</div>
    {cached && <div className="receipt-cache" role="status"><Badge kind="CACHED DEMO" /><p>{reason}</p></div>}
    <form onSubmit={e => { e.preventDefault(); void judge(); }} className="receipt-form"><label htmlFor="receipt-claim">Trick the parrot</label>
      <input id="receipt-claim" maxLength={200} value={claim} disabled={busy || cached} onChange={e => select(e.target.value)} aria-describedby="receipt-input-help" />
      <small id="receipt-input-help">3–200 characters. Your sentence and the fixed sample receipt are sent to OpenAI.</small>
      <button className="parrot-button" disabled={busy || !valid || (cached && !PRESETS.includes(claim))}>{busy ? "Judging…" : "Judge it!"}</button></form>
    <div className="receipt-result-grid"><section className="receipt-verdict" aria-live="polite" aria-label="Verdict">
      <h2>Matches the receipt?</h2><div key={serial} className={`receipt-cut ${verdict && settle(verdict) !== "faithful" ? "is-cut" : ""}`}>
        <p>{judged || claim}</p>{verdict && settle(verdict) !== "faithful" && <i className="receipt-blade" aria-hidden="true">✂</i>}</div>
      {verdict ? <><strong className="receipt-stamp" data-relation={settle(verdict)}>{STAMPS[settle(verdict)]}</strong><p>{(verdict.supported * 100).toFixed(1)}% grounding{cached ? " · hand-authored illustration" : ""}</p>{disagrees(verdict) && <p>The two checks disagree with each other, so the parrot will not stamp it.</p>}</> : <p>{busy ? "The jury is reading…" : "A sentence goes in. A paper trail comes out."}</p>}
    </section><DecisionsLens verdict={verdict} live={live} cached={cached} roundTrip={roundTrip} /></div>
    <p className="receipt-honesty">A second model checks the sentence against this sample receipt. It measures whether the sentence matches the receipt, not whether the market is right. Parrot&apos;s opinion, not advice.</p>
  </main>;
}

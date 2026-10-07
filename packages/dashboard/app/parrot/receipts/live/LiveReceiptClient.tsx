"use client";
import { useEffect, useRef, useState } from "react";
import { Badge } from "../../../../components/parrot/Badge";
import { ParrotAvatar } from "../../../../components/parrot/ParrotAvatar";
import { ParrotEffectsProvider, useParrotEffects } from "../../../../components/parrot/ParrotEffects";
import { WalletBoard, WaitingFlock } from "../../../../components/parrot/WalletBoard";
import { LiveTalk } from "../../../../components/parrot/LiveTalk";
import { useLiveTalk } from "../../../../components/parrot/useLiveTalk";
import { DecisionsLens } from "../../../../components/parrot/DecisionsLens";
import { canDemo } from "../../../../components/parrot/api";
import { settle, STAMPS } from "../../../../lib/parrot-receipts";
import { useSentenceReceipts } from "../../../../components/parrot/useSentenceReceipts";
import { emptyReceiptFeed, type ReceiptFeed } from "../../../../lib/parrot-judge-queue";
import { PARROT_PRESETS } from "../../../../lib/parrot-presets";
import type { ChatResponse } from "../../../../lib/parrot";
export default function LiveReceiptClient() { return <ParrotEffectsProvider><LiveReceiptContent /></ParrotEffectsProvider>; }
export function LiveReceiptContent({ initialFeed = emptyReceiptFeed(), initialFacts = "" }: { initialFeed?: ReceiptFeed; initialFacts?: string }) {
  const fx = useParrotEffects(), fxRef = useRef(fx); fxRef.current = fx;
  const [selected, setSelected] = useState<number>();
  const [chat, setChat] = useState<ChatResponse | null>(null), [demo, setDemo] = useState(false), [stale, setStale] = useState(false);
  const mounted = useRef(true), lastSound = useRef(-Infinity);
  const receipts = useSentenceReceipts({ initialFeed, initialFacts, pauseOnFailure: false, onVerdict: row => {
      if (!mounted.current) return;
      const effect = fxRef.current, now = performance.now();
      if (!row?.decision || row.decision.statesAFact < .5 || document.hidden || effect.quiet || !effect.sound ||
          !effect.sfx.enabled || now - effect.sfx.lastInput < 1200 || now - lastSound.current < 700) return;
      lastSound.current = now;
      const relation = settle(row.decision);
      effect.sfx.kit().cue({ kind: relation === "faithful" ? "sprinkle" : relation === "contradicted" ? "nope" : "bubble", at: 0, pitch: 0 });
  } });
  const { feed, facts, stop, observers } = receipts;
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; stop(); }; }, []);
  function begin() {
    receipts.begin(); setSelected(undefined); setDemo(false); setChat(null); setStale(false); lastSound.current = -Infinity;
    void fx.sfx.unlock().then(() => fx.sfx.play("start"));
  }
  const live = useLiveTalk(result => { setChat(result); setDemo(false); setStale(false); }, () => { setChat(null); setStale(true); },
    demo ? [] : chat?.shortlist.addresses ?? [], { gesture: begin, input: () => fx.sfx.input() }, {
      onParrotDelta: observers.onParrotDelta,
      onStrategyFacts: observers.onStrategyFacts,
      onEnd: stop,
    });
  const row = feed.rows.find(r => r.id === selected) ?? feed.rows[0];
  return <main className={`parrot-page receipt-page ${fx.quiet ? "receipt-quiet" : ""}`} data-calm={fx.quiet}>
    <header className="receipt-header"><a href="/parrot/receipts">← Sample Receipt Guillotine</a>
      <small>Decisions calls this call: {feed.calls} · ${feed.cost.toFixed(8)}<br />Attempts · estimated cost of confirmed results; failed calls may cost extra</small></header>
    <h1>Receipt Guillotine · Live</h1><p className="receipt-subtitle">The beak keeps talking. The paperwork keeps up.</p>
    <section className="receipt-live-stage" aria-label="Talk with PerpParrot">
      <ParrotAvatar state={live.view.phase === "connecting" ? "thinking" : live.active ? live.view.avatar : "idle"}
        stream={live.remoteStream} live={live.view.phase === "live" && !live.view.playbackBlocked} />
      <LiveTalk live={live} disabled={false} />
      {stale && <p role="status">Our last change did not finish, so I cleared the plan. Talk live again to redo it.</p>}
      {!live.active && !demo && canDemo(live.view.failure) && <button className="parrot-button" onClick={() => { setDemo(true); setChat(PARROT_PRESETS[0].chat); }}>Play the cached demo</button>}
      {demo && <p><Badge kind="CACHED DEMO" /> Bundled flock only; no voice or receipt judgments.</p>}
    </section>
    {chat ? <WalletBoard chat={chat} /> : <WaitingFlock />}
    <section className="receipt-paper" aria-label="Receipt of this turn"><h2>Receipt of this turn</h2><pre>{facts || "Waiting for strategy facts. Greetings are skipped."}</pre></section>
    {feed.paused && <p role="status">Receipts paused · the voice call can continue. Start a new call to retry.</p>}
    <p>{feed.skipped} sentences skipped · up to 12 judgments per turn</p>
    <div className="receipt-result-grid"><section className="receipt-feed" aria-label="The Parrot's receipts"><h2>The Parrot&apos;s receipts</h2>
      {!feed.rows.length && <p>Finished sentences appear here while the Parrot talks.</p>}
      {feed.rows.map(item => {
        const verdict = item.decision, banter = !!verdict && verdict.statesAFact < .5, outcome = verdict && settle(verdict);
        return <button key={item.id} type="button" className={`receipt-card ${banter ? "is-banter" : ""}`} aria-pressed={row?.id === item.id} onClick={() => setSelected(item.id)}>
          <div className={`receipt-cut ${verdict && !banter && outcome !== "faithful" ? "is-cut" : ""}`}><p>{item.claim}</p>
            {verdict && !banter && outcome !== "faithful" && <i className="receipt-blade" aria-hidden="true">✂</i>}</div>
          {banter ? <small>banter</small> : verdict && outcome ? <><strong className="receipt-stamp" data-relation={outcome}>{STAMPS[outcome]}</strong><p>{(verdict.supported * 100).toFixed(1)}% grounding</p></>
            : <small>{item.state === "checking" ? "✓ checking..." : item.state === "skipped" ? "Skipped" : "Receipt unavailable"}</small>}
        </button>;
      })}
    </section><div><DecisionsLens verdict={row?.decision} live={row?.decision} cached={false} roundTrip={row?.roundTrip} />
      {row && row.facts !== facts && <details><summary>Receipt used for this sentence</summary><pre className="receipt-bound-facts">{row.facts || "No facts yet"}</pre></details>}</div></div>
    <p className="receipt-honesty">Matches the receipt, not the market. Parrot&apos;s opinion, not advice. Voice and completed sentences with their turn facts are processed by OpenAI. The parrot cannot trade.</p>
  </main>;
}

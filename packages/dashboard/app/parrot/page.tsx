"use client";

// Voice-first wallet exploration page over the existing selection pipeline.
// Show checked facts and save pending requests only; never authorize execution.

import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { Badge } from "../../components/parrot/Badge";
import { ParrotAvatar, type AvatarState } from "../../components/parrot/ParrotAvatar";
import { ExecutePanel } from "../../components/parrot/ExecutePanel";
import { StageFlock } from "../../components/parrot/StageFlock";
import { DryBird, Icon, StageBurst } from "../../components/parrot/StageBits";
import { WalletBird } from "../../components/parrot/WalletBird";
import { Parrot, ParrotSymbols } from "../../components/lp/ParrotSymbols";
import { LiveTalk } from "../../components/parrot/LiveTalk";
import { LiveCards } from "../../components/parrot/LiveCards";
import type { LiveCard } from "../../lib/parrot-reads";
import { CompactReceipt } from "../../components/parrot/CompactReceipt";
import { useSentenceReceipts } from "../../components/parrot/useSentenceReceipts";
import { useLiveTalk } from "../../components/parrot/useLiveTalk";
import { canDemo, post, type Failure } from "../../components/parrot/api";
import { isPreviewResponse, type ChatResponse, type PreviewResponse } from "../../lib/parrot";
import { PARROT_PRESETS, type ParrotPreset } from "../../lib/parrot-presets";
import { ParrotEffectsProvider, useParrotEffects } from "../../components/parrot/ParrotEffects";
import { diffWallets } from "../../lib/wallet-board";
import "../lp.css"; // shared landing palette and symbols
import "./parrot-show.css";
import "./parrot-lp.css"; // the landing page's soft theme on this page (light only)

// Development-only: the whole module is behind a constant condition, so production builds contain neither the import nor its chunk.
const EffectsLab = process.env.NODE_ENV !== "production"
  ? lazy(() => import("../../components/parrot/EffectsLab").then(m => ({ default: m.EffectsLab })))
  : null;

export default function ParrotPage() { return <ParrotEffectsProvider><ParrotContent /></ParrotEffectsProvider>; }
function ParrotContent() {
  const fx = useParrotEffects();
  const fxRef = useRef(fx); fxRef.current = fx;
  const lastChat = useRef<ChatResponse | null>(null);
  const [chat, setChat] = useState<ChatResponse | null>(null);
  const [preview, setPreview] = useState<PreviewResponse | null>(null);
  const [demo, setDemo] = useState<ParrotPreset | null>(null);
  const [step, setStep] = useState<0 | 2>(0);
  const [previewError, setPreviewError] = useState<Failure | null>(null);
  const [busy, setBusy] = useState(false);
  const [stale, setStale] = useState(false);
  const [lab, setLab] = useState(false);
  const [card, setCard] = useState<LiveCard | null>(null); // the latest read-only Dashboard card the parrot put up
  // Development-only effects lab: open /parrot?fx=1 (never rendered in production builds).
  useEffect(() => { if (process.env.NODE_ENV !== "production" && new URLSearchParams(location.search).get("fx") === "1") setLab(true); }, []);
  const request = useRef<AbortController | null>(null);
  const receipts = useSentenceReceipts();
  const live = useLiveTalk(result => {
    setStale(false); setChat(result); setDemo(null); setPreview(null); setPreviewError(null); setStep(0);
    setCard(c => (c?.kind === "request" ? null : c)); // a new strategy voids a summary or sketch of the old one
  }, () => {
    setChat(null); setPreview(null); setDemo(null); setPreviewError(null); setStep(0); setStale(true);
  }, demo ? [] : chat?.shortlist.addresses ?? [], { gesture: () => {
    receipts.begin();
    // Cached preset identities are illustrations, not server finalist identities.
    if (demo) { setChat(null); setDemo(null); setPreview(null); setStep(0); }
    void fx.sfx.unlock().then(() => fx.sfx.play("start"));
  }, input: () => fx.sfx.input() }, { ...receipts.observers, onCard: setCard, onRequestSaved: saved => { setPreview(saved); setPreviewError(null); setStep(2); } });

  useEffect(() => {
    if (chat && chat !== lastChat.current) {
      const diff = diffWallets(lastChat.current?.shortlist.addresses ?? [], chat.shortlist.addresses);
      fxRef.current.trigger("strategy", chat.shortlist.addresses.length, diff.removed.length);
    }
    lastChat.current = chat;
  }, [chat]);
  useEffect(() => { if (preview) fxRef.current.trigger("lock"); }, [preview]);

  useEffect(() => () => request.current?.abort(), []);

  function playDemo() {
    if (request.current || live.active || !canDemo(live.view.failure)) return;
    void fx.sfx.unlock();
    const preset = PARROT_PRESETS[0];
    setStale(false); setDemo(preset); setChat(preset.chat); setPreview(null); setPreviewError(null); setStep(0);
  }

  async function confirm() {
    if (!chat || preview || request.current || live.active || !chat.shortlist.addresses.length) return;
    if (demo) { setPreview(demo.preview); return; }
    const controller = new AbortController(); request.current = controller;
    setBusy(true); setPreviewError(null);
    const result = await post("/chat/preview", { intent: chat.intent }, isPreviewResponse, AbortSignal.any([controller.signal, AbortSignal.timeout(30_000)]));
    if (controller.signal.aborted) return;
    if ("data" in result) setPreview(result.data);
    else setPreviewError(result.error);
    request.current = null; setBusy(false);
  }

  const state: AvatarState = live.view.phase === "connecting" ? "thinking" : live.active ? live.view.avatar : busy ? "thinking" : "idle";

  return <main data-calm={fx.quiet} className="parrot-page parrot-show">
    <ParrotSymbols />
    <div className="parrot-awning" aria-hidden="true" />
    <div className="parrot-shell">
      <header className="parrot-top">
        <a href="/" className="parrot-back" aria-label="Back to Dashboard"><Icon kind="back" /></a>
        <h1 className="parrot-brand"><Parrot />PerpParrot</h1>
        <div className="show-controls">
          <button type="button" aria-label={`Sound effects ${fx.sound ? "on" : "off"}`} aria-pressed={fx.sound} onClick={fx.toggleSound}><Icon kind="sound" /></button>
          <button type="button" aria-label="Calm mode" aria-pressed={fx.calm} onClick={fx.toggleCalm}><Icon kind="moon" /></button>
        </div>
      </header>
      <div className="show-floor">
        <section className="parrot-stage" aria-label="Talk with PerpParrot">
          <div className="parrot-scene">
            <span className="show-shout" aria-hidden="true">SQUAWK!</span>
            <div className="show-rosette" aria-hidden="true">ALL<br />BEAK</div>
            <ParrotAvatar state={state} stream={live.remoteStream} live={live.view.phase === "live" && !live.view.playbackBlocked} />
            {state === "thinking" && <div className="thinking-seeds" aria-hidden="true"><i /><i /><i /><i /><i /></div>}
          </div>
          <div className="voice-dock">
            <LiveTalk live={live} disabled={busy} />
            <CompactReceipt active={live.view.phase === "live"} {...receipts} />
            {stale && <p className="stage-error" role="status">Plan cleared</p>}
            {!live.active && !demo && canDemo(live.view.failure) && <button type="button" className="parrot-button demo-button" onClick={playDemo}>Cached demo</button>}
          </div>
        </section>
        <div className="show-screen" data-kind={card?.kind ?? (preview ? "saved" : chat ? "flock" : "idle")}>
          <div className="screen-label"><span>THE BEAK SHOW</span>{demo && <Badge kind="CACHED DEMO" />}{(card || step === 2) && chat?.shortlist.dataSource === "sample" && <Badge kind="SAMPLE DATA" />}</div>
          <StageBurst />
          {chat && <div className="flock-stage" hidden={!!card || step === 2}>
            <span className="strategy-style">{chat.intent.riskStyle}</span>
            <StageFlock chat={chat} />
            <button type="button" className="parrot-button parrot-button--primary" disabled={!chat.shortlist.addresses.length} onClick={() => setStep(2)}><DryBird />{preview ? "Saved" : "Lock it?"}</button>
            {!card && step === 0 && <p className="sr-only" role="status">Strategy ready. Review the flock and hold to save a pending request.</p>}
          </div>}
          {card ? <LiveCards card={card} onClose={() => setCard(null)} onConfirm={() => void live.confirmNow()} />
          : chat ? step === 2 ? <>
            <button type="button" className="stage-close" aria-label="Back to flock" onClick={() => setStep(0)}><Icon kind="back" /></button>
            <ExecutePanel chat={chat} demo={!!demo} result={preview} busy={busy} failure={previewError} onConfirm={() => void confirm()} executionDisabled={live.active} />
          </> : null : <div className="show-idle">
            <span className="leaf-chip">Voice powered</span>
            <h2>YOUR<br /><em>FLOCK.</em></h2>
            <div className="waiting-wire" aria-hidden="true"><WalletBird vibe="calm" /><WalletBird vibe="wild" /><WalletBird vibe="steady" /></div>
            <p>Say something.</p>
          </div>}
        </div>
      </div>
      {lab && EffectsLab && <Suspense fallback={null}><EffectsLab onCard={setCard}
        onPreset={preset => { setStale(false); setDemo(preset); setChat(preset.chat); setPreview(null); setPreviewError(null); setStep(0); }}
        onLock={() => { const p = demo ?? PARROT_PRESETS[0]; if (!demo) { setDemo(p); setChat(p.chat); } setPreview(p.preview); setStep(2); }}
        onReset={() => { setChat(null); setDemo(null); setPreview(null); setStep(0); lastChat.current = null; }} /></Suspense>}
      <footer className="parrot-privacy">not advice · the parrot cannot trade</footer>
    </div>
  </main>;
}

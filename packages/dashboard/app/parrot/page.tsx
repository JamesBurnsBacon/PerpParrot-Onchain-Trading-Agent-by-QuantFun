"use client";

import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { Badge } from "../../components/parrot/Badge";
import { ParrotAvatar, type AvatarState } from "../../components/parrot/ParrotAvatar";
import { StepRail, type Step } from "../../components/parrot/StepRail";
import { ThemeToggle } from "../../components/parrot/ThemeToggle";
import { LiveTalk } from "../../components/parrot/LiveTalk";
import { useLiveTalk } from "../../components/parrot/useLiveTalk";
import { canDemo, post, type Failure } from "../../components/parrot/api";
import { isPreviewResponse, type ChatResponse, type PreviewResponse } from "../../lib/parrot";
import { PARROT_PRESETS, type ParrotPreset } from "../../lib/parrot-presets";
import { ParrotEffectsProvider, useParrotEffects, FunControls, Fever } from "../../components/parrot/ParrotEffects";
import { diffWallets } from "../../lib/wallet-board";
import { WaitingFlock } from "../../components/parrot/WalletBoard";
import "./parrot.css";

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
  const [step, setStep] = useState<Step>(0);
  const [previewError, setPreviewError] = useState<Failure | null>(null);
  const [busy, setBusy] = useState(false);
  const [stale, setStale] = useState(false);
  const [lab, setLab] = useState(false);
  // Development-only effects lab: open /parrot?fx=1 (never rendered in production builds).
  useEffect(() => { if (process.env.NODE_ENV !== "production" && new URLSearchParams(location.search).get("fx") === "1") setLab(true); }, []);
  const request = useRef<AbortController | null>(null);
  const live = useLiveTalk(result => {
    setStale(false); setChat(result); setDemo(null); setPreview(null); setPreviewError(null); setStep(0);
  }, () => {
    setChat(null); setPreview(null); setDemo(null); setPreviewError(null); setStep(0); setStale(true);
  }, demo ? [] : chat?.shortlist.addresses ?? [], { gesture: () => {
    // Cached preset identities are illustrations, not server finalist identities.
    if (demo) { setChat(null); setDemo(null); setPreview(null); setStep(0); }
    void fx.sfx.unlock().then(() => fx.sfx.play("start"));
  }, input: () => fx.sfx.input() });

  useEffect(() => {
    if (chat && chat !== lastChat.current) {
      const diff = diffWallets(lastChat.current?.shortlist.addresses ?? [], chat.shortlist.addresses);
      fxRef.current.trigger("strategy", chat.shortlist.addresses.length, diff.removed.length, chat.policy.clamps.length > 0);
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

  return <main data-calm={fx.quiet} className="parrot-page px-4 py-5 sm:px-7 sm:py-7">
    <div className="parrot-shell mx-auto max-w-[1240px]">
      <header className="flex items-center justify-between gap-3">
        <a href="/" className="parrot-back">← Dashboard</a>
        <h1 className="sr-only">Talk with PerpParrot</h1>
        <ThemeToggle />
      </header>
      <div className="parrot-layout parrot-layout--result">
        <section className="parrot-stage min-w-0" aria-label="Talk with PerpParrot">
          <div className="parrot-scene"><ParrotAvatar state={state} stream={live.remoteStream} live={live.view.phase === "live" && !live.view.playbackBlocked} /></div>
          <LiveTalk live={live} disabled={busy} />
          <FunControls />
          {stale && <p className="parrot-live-status" role="status">Our last change did not finish, so I cleared the plan. Talk live again to redo it.</p>}
          {!live.active && !demo && canDemo(live.view.failure) && <button type="button" className="parrot-button mt-3" onClick={playDemo}>Play the cached demo</button>}
          {demo && <div className="mt-4"><Badge kind="CACHED DEMO" /></div>}
        </section>
        {chat && <div className="parrot-result min-w-0" data-fever={fx.celebration?.animated || undefined}>
          <div className="wallet-board-heading"><Badge kind={chat.shortlist.dataSource === "sample" ? "SAMPLE DATA" : "LIVE"} /><small>No orders are placed.</small></div>
          <Fever />
          <p className="sr-only" role="status">Strategy ready. Review Select, Verify, and Execute.</p>
          <StepRail chat={chat} demo={!!demo} step={step} setStep={setStep} preview={preview} busy={busy} executionDisabled={live.active} failure={previewError} onConfirm={() => void confirm()} />
        </div>}
        {!chat && <WaitingFlock />}
      </div>
      {lab && EffectsLab && <Suspense fallback={null}><EffectsLab
        onPreset={preset => { setStale(false); setDemo(preset); setChat(preset.chat); setPreview(null); setPreviewError(null); setStep(0); }}
        onLock={() => { const p = demo ?? PARROT_PRESETS[0]; if (!demo) { setDemo(p); setChat(p.chat); } setPreview(p.preview); }}
        onReset={() => { setChat(null); setDemo(null); setPreview(null); setStep(0); lastChat.current = null; }} /></Suspense>}
      <footer className="parrot-privacy">Voice is processed by OpenAI. The parrot cannot trade.</footer>
    </div>
  </main>;
}

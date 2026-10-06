"use client";

import { useEffect, useRef, useState } from "react";
import { Badge } from "../../components/parrot/Badge";
import { ParrotAvatar, type AvatarState } from "../../components/parrot/ParrotAvatar";
import { StepRail, type Step } from "../../components/parrot/StepRail";
import { ThemeToggle } from "../../components/parrot/ThemeToggle";
import { LiveTalk } from "../../components/parrot/LiveTalk";
import { useLiveTalk } from "../../components/parrot/useLiveTalk";
import { canDemo, post, type Failure } from "../../components/parrot/api";
import { isPreviewResponse, type ChatResponse, type PreviewResponse } from "../../lib/parrot";
import { PARROT_PRESETS, type ParrotPreset } from "../../lib/parrot-presets";
import "./parrot.css";

export default function ParrotPage() {
  const [chat, setChat] = useState<ChatResponse | null>(null);
  const [preview, setPreview] = useState<PreviewResponse | null>(null);
  const [demo, setDemo] = useState<ParrotPreset | null>(null);
  const [step, setStep] = useState<Step>(0);
  const [previewError, setPreviewError] = useState<Failure | null>(null);
  const [busy, setBusy] = useState(false);
  const [revision, setRevision] = useState(0);
  const request = useRef<AbortController | null>(null);
  const live = useLiveTalk(result => {
    setChat(result); setDemo(null); setPreview(null); setPreviewError(null); setStep(0);
    setRevision(value => value + 1);
  });

  useEffect(() => () => request.current?.abort(), []);

  function playDemo() {
    if (request.current || live.active || !canDemo(live.view.failure)) return;
    const preset = PARROT_PRESETS[0];
    setDemo(preset); setChat(preset.chat); setPreview(null); setPreviewError(null); setStep(0);
    setRevision(value => value + 1);
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

  return <main className="parrot-page px-4 py-5 sm:px-7 sm:py-7">
    <div className="parrot-shell mx-auto max-w-[1240px]">
      <header className="flex items-center justify-between gap-3">
        <a href="/" className="parrot-back">← Dashboard</a>
        <h1 className="sr-only">Talk with PerpParrot</h1>
        <ThemeToggle />
      </header>
      <div className={`parrot-layout${chat ? " parrot-layout--result" : ""}`}>
        <section className="parrot-stage min-w-0" aria-label="Talk with PerpParrot">
          <div className="parrot-scene"><ParrotAvatar state={state} /></div>
          <LiveTalk live={live} disabled={busy} />
          {!live.active && !demo && canDemo(live.view.failure) && <button type="button" className="parrot-button mt-3" onClick={playDemo}>Play the cached demo</button>}
          {demo && <div className="mt-4"><Badge kind="CACHED DEMO" /></div>}
        </section>
        {chat && <div key={revision} className="parrot-result min-w-0">
          <p className="sr-only" role="status">Strategy ready. Review Select, Verify, and Execute.</p>
          <StepRail chat={chat} demo={!!demo} step={step} setStep={setStep} preview={preview} busy={busy} executionDisabled={live.active} failure={previewError} onConfirm={() => void confirm()} />
        </div>}
      </div>
      <footer className="parrot-privacy">Voice is processed by OpenAI. The parrot cannot trade.</footer>
    </div>
  </main>;
}

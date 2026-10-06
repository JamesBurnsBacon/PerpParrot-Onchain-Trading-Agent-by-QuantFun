"use client";

import { useEffect, useRef, useState } from "react";
import { Badge } from "../../components/parrot/Badge";
import { ParrotAvatar, type AvatarState } from "../../components/parrot/ParrotAvatar";
import { SpeechBubble } from "../../components/parrot/SpeechBubble";
import { StepRail, type Step } from "../../components/parrot/StepRail";
import { ThemeToggle } from "../../components/parrot/ThemeToggle";
import { LiveTalk } from "../../components/parrot/LiveTalk";
import { useLiveTalk } from "../../components/parrot/useLiveTalk";
import { VoiceInput } from "../../components/parrot/VoiceInput";
import { canDemo, post, type Failure } from "../../components/parrot/api";
import { describeError, isChatResponse, isPreviewResponse, type ChatResponse, type HistoryTurn, type PreviewResponse } from "../../lib/parrot";
import { PARROT_PRESETS, type ParrotPreset } from "../../lib/parrot-presets";
import "./parrot.css";

const greeting = "Hey, I'm PerpParrot. Tell me your strategy idea — cautious, curious, or a little wild. I'll help you explore it within the code's limits.";

export default function ParrotPage() {
  const [message, setMessage] = useState("");
  const [history, setHistory] = useState<HistoryTurn[]>([]);
  const [chat, setChat] = useState<ChatResponse | null>(null);
  const [preview, setPreview] = useState<PreviewResponse | null>(null);
  const [demo, setDemo] = useState<ParrotPreset | null>(null);
  const [selected, setSelected] = useState(PARROT_PRESETS[0]);
  const [step, setStep] = useState<Step>(0);
  const [chatError, setChatError] = useState<Failure | null>(null);
  const [previewError, setPreviewError] = useState<Failure | null>(null);
  const [busy, setBusy] = useState<"chat" | "preview" | null>(null);
  const [listening, setListening] = useState(false);
  const [typing, setTyping] = useState(false);
  const [readAloud, setReadAloud] = useState(false);
  const [canSpeak, setCanSpeak] = useState(false);
  const request = useRef<AbortController | null>(null);
  const input = useRef<HTMLTextAreaElement | null>(null);
  const live = useLiveTalk(result => {
    setChat(result); setDemo(null); setPreview(null); setChatError(null); setPreviewError(null); setStep(0);
  });
  const reply = chatError ? describeError(chatError.code, chatError.retryAfterSec) : chat?.reply ?? greeting;

  useEffect(() => {
    setCanSpeak("speechSynthesis" in window && "SpeechSynthesisUtterance" in window);
    return () => { request.current?.abort(); if ("speechSynthesis" in window) window.speechSynthesis.cancel(); };
  }, []);
  useEffect(() => {
    if (!canSpeak) return;
    window.speechSynthesis.cancel();
    if (readAloud && !live.active) {
      const utterance = new SpeechSynthesisUtterance(reply);
      utterance.lang = navigator.language;
      window.speechSynthesis.speak(utterance);
    }
    return () => window.speechSynthesis.cancel();
  }, [reply, readAloud, canSpeak, live.active]);

  async function send() {
    const text = message.trim();
    if (!text || text.length > 500 || request.current || demo || listening || live.active) return;
    const controller = new AbortController(); request.current = controller;
    setBusy("chat"); setChatError(null); setPreviewError(null); setPreview(null); setChat(null); setStep(0);
    const result = await post("/chat", { message: text, history }, isChatResponse, AbortSignal.any([controller.signal, AbortSignal.timeout(30_000)]));
    if (controller.signal.aborted) return;
    if ("data" in result) {
      setChat(result.data); setMessage("");
      setHistory(previous => [...previous, { role: "user" as const, text: text.slice(0, 400) }, { role: "parrot" as const, text: result.data.reply.slice(0, 400) }].slice(-6));
    } else setChatError(result.error);
    request.current = null; setBusy(null);
  }

  function playDemo(preset = selected) {
    if (request.current || live.active) return;
    setSelected(preset); setDemo(preset); setChat(preset.chat); setPreview(null); setChatError(null); setPreviewError(null);
    setHistory([]); setMessage(""); setStep(0);
  }

  async function confirm() {
    if (!chat || preview || request.current || live.active || !chat.shortlist.addresses.length) return;
    if (demo) { setPreview(demo.preview); return; }
    const controller = new AbortController(); request.current = controller;
    setBusy("preview"); setPreviewError(null);
    const result = await post("/chat/preview", { intent: chat.intent }, isPreviewResponse, AbortSignal.any([controller.signal, AbortSignal.timeout(30_000)]));
    if (controller.signal.aborted) return;
    if ("data" in result) setPreview(result.data);
    else setPreviewError(result.error);
    request.current = null; setBusy(null);
  }

  const state: AvatarState = live.active ? live.view.avatar : busy ? "thinking" : listening ? "listening" : preview ? "locked" : typing ? "speaking" : "idle";
  const stateLabel = { idle: "Ready when you are", listening: "Listening · release to finish", thinking: "Checking with code…", speaking: "A little bird says…", locked: "Pending · awaiting operator freeze" }[state];

  return <main className="parrot-page min-h-screen px-4 py-5 sm:px-7 sm:py-7">
    <div className="mx-auto max-w-[1240px]">
      <header className="mb-7 flex flex-wrap items-center gap-3">
        <a href="/" className="parrot-back">← Dashboard</a>
        <span className="parrot-eyebrow mr-auto">PERPPARROT / STRATEGY STUDIO</span>
        <ThemeToggle />
      </header>
      <div className="mb-7 flex flex-wrap items-end justify-between gap-4">
        <div><p className="parrot-eyebrow mb-2">YOU BRING THE IDEA. CODE SETS THE BOUNDS.</p><h1 className="text-3xl font-black tracking-tight sm:text-4xl">Talk to the Parrot<span style={{ color: "var(--parrot-deep)" }}>.</span></h1></div>
        <span className="parrot-chip"><span aria-hidden="true" className="parrot-status-dot" />Conversation → pending request</span>
      </div>
      <div className="parrot-layout">
        <section className="parrot-stage min-w-0" aria-label="Talk with PerpParrot" aria-busy={busy === "chat"}>
          <div className="flex items-center justify-between gap-2"><span className="parrot-eyebrow">MEET YOUR FEATHERED COPILOT</span>{demo && <Badge kind="CACHED DEMO" />}</div>
          <div className="parrot-scene"><span className="parrot-orbit parrot-orbit--one" aria-hidden="true" /><span className="parrot-orbit parrot-orbit--two" aria-hidden="true" /><ParrotAvatar state={state} demo={!!demo} /></div>
          <p role="status" className="mb-4 text-center text-xs font-semibold" style={{ color: "var(--ink-2)" }}>{live.active ? (live.view.phase === "connecting" ? "Connecting voice…" : "Live conversation") : stateLabel}</p>
          <SpeechBubble captions={live.active ? { user: live.view.user, parrot: live.view.parrot } : undefined} reply={reply} clarify={chatError ? null : chat?.clarify ?? null} onTyping={setTyping} />
          {chatError && <div className="mt-3" role="alert"><p className="sr-only">{describeError(chatError.code, chatError.retryAfterSec)}</p>{canDemo(chatError) && <button className="parrot-button w-full" onClick={() => playDemo()}>Play the cached demo</button>}</div>}
          <div className="mt-5"><p className="parrot-eyebrow mb-2">{demo ? "TRY ANOTHER CACHED SCENARIO" : "A PLACE TO START"}</p>
            <div className="flex flex-wrap gap-2">{PARROT_PRESETS.map(preset => <button type="button" className="parrot-preset" key={preset.id} disabled={!!busy || listening || live.active} aria-pressed={selected.id === preset.id}
              onClick={() => { setSelected(preset); if (demo) playDemo(preset); else { setMessage(preset.message); input.current?.focus(); } }}>{preset.label}<span aria-hidden="true"> ↗</span></button>)}</div>
          </div>
          {demo ? <div className="parrot-rule mt-4"><p className="text-sm">Canned replies and synthetic wallets. No backend is needed; nothing is saved to a server.</p><button className="parrot-button mt-3" onClick={() => { setDemo(null); setChat(null); setPreview(null); setHistory([]); setStep(0); }}>Return to chat</button></div> :
            <form className="mt-4" onSubmit={event => { event.preventDefault(); void send(); }}>
              <label htmlFor="parrot-message" className="mb-2 block text-sm font-bold">What's your strategy idea?</label>
              <textarea ref={input} id="parrot-message" className="parrot-input w-full" rows={3} maxLength={500} value={message} disabled={!!busy || live.active} placeholder="I'd like a diversified strategy with a little less risk…"
                aria-describedby="parrot-input-help" onChange={event => setMessage(event.target.value)}
                onKeyDown={event => { if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); void send(); } }} />
              <div id="parrot-input-help" className="mt-1 flex justify-between gap-2 text-xs" style={{ color: "var(--ink-2)" }}><span>Enter to send · Shift + Enter for a new line</span><span>{message.length}/500</span></div>
              <div className="mt-3 flex flex-wrap items-start justify-between gap-2"><VoiceInput disabled={!!busy || live.active} onTranscript={setMessage} onListening={setListening} /><button className="parrot-button parrot-button--primary ml-auto" type="submit" disabled={!!busy || !message.trim() || listening || live.active}>{busy === "chat" ? "Thinking…" : "Send"}<span aria-hidden="true"> ↗</span></button></div>
            </form>}
          {!demo && <LiveTalk live={live} disabled={!!busy || listening} />}
          <div className="mt-4 flex flex-wrap items-center justify-between gap-2 text-xs" style={{ color: "var(--ink-2)" }}>
            {canSpeak && <label className="flex items-center gap-2"><input type="checkbox" checked={readAloud} onChange={event => setReadAloud(event.target.checked)} /> Read replies aloud</label>}
            {chat && <span className="break-all">{chat.model} · {chat.latencyMs} ms</span>}
          </div>
        </section>
        <StepRail chat={chat} demo={!!demo} step={step} setStep={setStep} preview={preview} busy={!!busy || live.active} failure={previewError} onConfirm={() => void confirm()} onDemo={() => playDemo()} />
      </div>
      <footer className="mx-auto mt-8 max-w-3xl pb-3 text-center text-xs leading-relaxed" style={{ color: "var(--ink-2)" }}>The parrot only reads your words. Code sets the limits. Only a signed report can trade.</footer>
    </div>
  </main>;
}

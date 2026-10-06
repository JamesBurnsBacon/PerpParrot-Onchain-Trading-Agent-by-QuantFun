import { useCallback, useEffect, useRef, useState } from "react";

type Recognition = {
  lang: string; continuous: boolean; interimResults: boolean;
  onresult: ((event: { results: ArrayLike<ArrayLike<{ transcript: string }>> }) => void) | null;
  onerror: ((event: { error?: string }) => void) | null; onend: (() => void) | null; onstart: (() => void) | null;
  start: () => void; stop: () => void; abort: () => void;
};
type SpeechWindow = Window & { SpeechRecognition?: new () => Recognition; webkitSpeechRecognition?: new () => Recognition };

export function describeVoiceError(code?: string): string {
  switch (code) {
    case "not-allowed": case "service-not-allowed": return "Microphone is blocked. Allow it for this site in the browser's site settings, then try again (or type your message).";
    case "audio-capture": return "No microphone found. Check that one is connected, or type your message.";
    case "no-speech": return "I didn't hear anything. Hold the button while you speak, or type your message.";
    case "network": return "Speech recognition needs a network connection to the browser's speech service. Try Chrome, or type your message.";
    case "aborted": return "";
    default: return `Voice input failed${code ? ` (${code})` : ""}. You can still type your message.`;
  }
}

export function VoiceInput({ disabled, onTranscript, onListening }: { disabled: boolean; onTranscript: (text: string) => void; onListening: (value: boolean) => void }) {
  const [supported, setSupported] = useState(false);
  const [listening, setListening] = useState(false);
  const [error, setError] = useState("");
  const recognition = useRef<Recognition | null>(null);
  const held = useRef(false);
  const stopping = useRef(false);
  const stop = useCallback(() => {
    held.current = false;
    setListening(false); onListening(false);
    const active = recognition.current;
    if (active && !stopping.current) { stopping.current = true; try { active.stop(); } catch { active.abort(); } }
  }, [onListening]);
  useEffect(() => {
    const speech = window as SpeechWindow;
    setSupported(!!(speech.SpeechRecognition || speech.webkitSpeechRecognition));
    const hide = () => { if (document.hidden) stop(); };
    document.addEventListener("visibilitychange", hide);
    return () => {
      if (recognition.current) {
        recognition.current.onresult = null; recognition.current.onerror = null;
        recognition.current.onend = null; recognition.current.onstart = null;
        recognition.current.abort();
      }
      document.removeEventListener("visibilitychange", hide);
    };
  }, [stop]);
  useEffect(() => { if (disabled) stop(); }, [disabled, stop]);

  function start() {
    if (disabled || recognition.current) return;
    const speech = window as SpeechWindow;
    const Constructor = speech.SpeechRecognition ?? speech.webkitSpeechRecognition;
    if (!Constructor) return;
    const instance = new Constructor();
    recognition.current = instance; held.current = true; stopping.current = false;
    instance.lang = navigator.language;
    instance.continuous = false; instance.interimResults = false;
    instance.onstart = () => {
      if (!held.current) { instance.stop(); return; }
      setListening(true); onListening(true);
    };
    instance.onresult = event => {
      const text = Array.from(event.results, result => result[0]?.transcript ?? "").join(" ").slice(0, 500);
      if (text) onTranscript(text); // Deliberately never sends the transcript.
    };
    instance.onerror = event => { setError(describeVoiceError(event.error)); stop(); };
    instance.onend = () => { recognition.current = null; held.current = false; setListening(false); onListening(false); };
    setError("");
    try { instance.start(); } catch { recognition.current = null; held.current = false; setError("Microphone unavailable. You can still type your message."); }
  }
  if (!supported) return null;
  return <div>
    <button type="button" className="parrot-button" disabled={disabled} aria-label="Hold to talk; release to place transcript in the message box" aria-pressed={listening}
      onPointerDown={event => { if (event.button === 0) { event.currentTarget.setPointerCapture(event.pointerId); start(); } }}
      onPointerUp={stop} onPointerCancel={stop} onPointerLeave={stop} onLostPointerCapture={stop} onBlur={stop}
      onKeyDown={event => { if (event.key === " " || event.key === "Enter") { event.preventDefault(); if (!event.repeat) start(); } }}
      onKeyUp={event => { if (event.key === " " || event.key === "Enter") { event.preventDefault(); stop(); } }}
      onContextMenu={event => { event.preventDefault(); stop(); }}>
      <svg width="16" height="20" viewBox="0 0 16 20" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true"><rect x="5" y="1" width="6" height="11" rx="3" /><path d="M2 8v2a6 6 0 0012 0V8M8 16v3M4 19h8" /></svg>
      {listening ? "Listening…" : "Hold to talk"}
    </button>
    {error && <p role="status" className="mt-2 max-w-64 text-xs">{error}</p>}
  </div>;
}

import { useEffect, useState } from "react";
import { typewriterFrames } from "../../lib/parrot";

export function SpeechBubble({ reply, clarify, onTyping, captions }: { captions?: { user: string; parrot: string }; reply: string; clarify: string | null; onTyping: (value: boolean) => void }) {
  const [shown, setShown] = useState(reply);
  const [complete, setComplete] = useState(false);
  const [reduceMotion, setReduceMotion] = useState(true);
  useEffect(() => {
    const query = window.matchMedia("(prefers-reduced-motion: reduce)");
    const update = () => setReduceMotion(query.matches);
    update(); query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);
  useEffect(() => { setComplete(false); }, [reply]);
  const live = captions !== undefined;
  useEffect(() => {
    if (live) { onTyping(false); return; }
    if (complete || reduceMotion) { setShown(reply); onTyping(false); return; }
    const frames = typewriterFrames(reply, 22);
    const start = performance.now();
    setShown(""); onTyping(true);
    const timer = setInterval(() => {
      const frame = Math.min(frames.length - 1, Math.floor((performance.now() - start) / 22));
      setShown(frames[frame].text);
      if (frame === frames.length - 1) { clearInterval(timer); onTyping(false); }
    }, 22);
    return () => { clearInterval(timer); onTyping(false); };
  }, [reply, complete, reduceMotion, onTyping, live]);
  if (captions) return <div className="parrot-bubble" aria-live="polite" aria-relevant="text">
    <span className="parrot-eyebrow">LIVE CONVERSATION</span>
    <div className="max-h-60 overflow-y-auto whitespace-pre-wrap break-words">
      <p className="mt-2 text-sm"><strong>You: </strong>{captions.user || "…"}</p>
      <p className="mt-2 text-base font-semibold"><strong>Parrot: </strong>{captions.parrot || "I'm listening."}</p>
    </div>
  </div>;
  return <div className="parrot-bubble">
    <span className="parrot-eyebrow">A WORD FROM YOUR PARROT</span>
    <button type="button" className="mt-2 block w-full text-left text-base font-semibold leading-relaxed" onClick={() => setComplete(true)}
      onKeyDown={event => { if (event.key !== "Tab") setComplete(true); }} aria-label="Show the full parrot reply">
      <span aria-hidden="true">{shown || "\u00a0"}</span>
    </button>
    <div className="sr-only" aria-live="polite" aria-atomic="true">{reply}{clarify ? ` ${clarify}` : ""}</div>
    {clarify && <p className="parrot-clarify mt-3 text-sm">{clarify}</p>}
    {shown !== reply && <p className="mt-2 text-xs" style={{ color: "var(--ink-2)" }}>Click or press a key on this bubble to finish.</p>}
  </div>;
}

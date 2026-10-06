import type { useLiveTalk } from "./useLiveTalk";

export function LiveTalk({ live, disabled }: { live: ReturnType<typeof useLiveTalk>; disabled: boolean }) {
  const { view } = live;
  const waiting = view.phase === "connecting" || view.phase === "closing";
  const status = view.phase === "connecting" ? "Connecting…" : view.phase === "closing" ? "Ending…"
    : live.active ? { listening: "Listening", thinking: "Thinking", speaking: "Speaking" }[view.avatar] : view.status;
  return <div className="parrot-live">
    <button type="button" className={`parrot-talk${live.active ? " parrot-talk--active" : ""}`}
      aria-label={live.active ? "End" : "Talk live"} aria-describedby="parrot-live-status"
      disabled={waiting || (!live.active && disabled)} onClick={() => live.active ? live.end() : void live.start()}>
      {waiting ? <span className="parrot-spinner" aria-hidden="true" /> : live.active ?
        <svg width="28" height="28" viewBox="0 0 24 24" aria-hidden="true"><rect x="5" y="5" width="14" height="14" rx="3" fill="currentColor" /></svg> :
        <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" aria-hidden="true"><rect x="8" y="2" width="8" height="13" rx="4" /><path d="M5 10v2a7 7 0 0014 0v-2M12 19v3m-4 0h8" /></svg>}
    </button>
    {!waiting && <span className="parrot-talk-label" aria-hidden="true">{live.active ? "End" : "Talk live"}</span>}
    <p id="parrot-live-status" className="parrot-live-status" role="status">{status}</p>
    {view.phase === "live" && <span className="parrot-countdown" role="timer" aria-label={`${view.remaining} seconds remaining`}>{Math.floor(view.remaining / 60)}:{String(view.remaining % 60).padStart(2, "0")}</span>}
    {live.active && view.playbackBlocked && <button type="button" className="parrot-button" onClick={() => void live.resumeAudio()}>Enable audio</button>}
    <div className="sr-only" aria-live="polite" aria-relevant="text">
      <p>{view.user && `You: ${view.user}`}</p>
      <p>{view.parrot && `Parrot: ${view.parrot}`}</p>
    </div>
    <audio ref={live.audio} autoPlay className="hidden" />
  </div>;
}

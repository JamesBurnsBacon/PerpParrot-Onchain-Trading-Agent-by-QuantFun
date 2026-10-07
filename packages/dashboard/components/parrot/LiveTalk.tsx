// Voice call controls rendered by the Parrot page from useLiveTalk state.
// Controls manage the conversation only and cannot authorize trades.
import { Icon } from "./StageBits";
import { waitPillLabel } from "../../lib/parrot";
import type { useLiveTalk } from "./useLiveTalk";

export function LiveTalk({ live, disabled }: { live: ReturnType<typeof useLiveTalk>; disabled: boolean }) {
  const { view } = live;
  const waiting = view.phase === "closing";
  const label = view.phase === "connecting" ? "Cancel" : live.active ? "End" : "Talk live";
  const idleStatus = !view.status ? "Your mic" : view.status === "Conversation canceled." ? "Canceled"
    : view.status.startsWith("Conversation ended") ? "Ended" : view.status.startsWith("Allow microphone") ? "Allow mic" : waitPillLabel(view.status) ?? "Try again";
  const status = view.phase === "connecting" ? "Connecting…" : view.phase === "closing" ? "Ending…"
    : live.active ? (view.muted && view.avatar === "listening" ? "Muted" : { listening: "Listening", thinking: "Thinking", speaking: "Speaking" }[view.avatar]) : idleStatus;
  // The state drives the pill color: listening, thinking, speaking, muted, connecting/closing, or idle.
  const meta = view.phase === "connecting" ? "connecting" : view.phase === "closing" ? "closing" : live.active ? (view.muted && view.avatar === "listening" ? "muted" : view.avatar) : "idle";
  return <div className="parrot-live">
    <div className="parrot-talk-row">
    <button type="button" className={`parrot-talk${live.active ? " parrot-talk--active" : ""}`}
      aria-label={view.phase === "connecting" ? "Cancel connecting" : label} aria-describedby="parrot-live-status"
      disabled={waiting || (!live.active && disabled)} onClick={() => live.active ? live.end() : void live.start()}>
      {waiting ? <span className="parrot-spinner" aria-hidden="true" /> : live.active ?
        <svg width="28" height="28" viewBox="0 0 24 24" aria-hidden="true"><rect x="5" y="5" width="14" height="14" rx="3" fill="currentColor" /></svg> :
        <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" aria-hidden="true"><rect x="8" y="2" width="8" height="13" rx="4" /><path d="M5 10v2a7 7 0 0014 0v-2M12 19v3m-4 0h8" /></svg>}
    </button>
    {view.phase === "live" && <button type="button" className={`parrot-mute${view.muted ? " is-muted" : ""}`} aria-pressed={view.muted}
      aria-label={view.muted ? "Unmute microphone" : "Mute microphone"} onClick={live.toggleMute}>
      <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true">
        <rect x="8" y="2" width="8" height="12" rx="4" /><path d="M5 10v2a7 7 0 0014 0v-2M12 19v3m-4 0h8" />{view.muted && <path d="M3 3l18 18" />}
      </svg>
    </button>}
    </div>
    {!waiting && <span className="parrot-talk-label" aria-hidden="true">{label}</span>}
    <div className="parrot-meta" data-state={meta}>
    <p id="parrot-live-status" className="parrot-live-status" role="status"><Icon kind={view.phase === "live" ? "check" : view.status && !live.active && idleStatus !== "Ended" && idleStatus !== "Canceled" ? "alert" : "sound"} />{status}{!live.active && view.status && <span className="sr-only">{view.status}</span>}</p>
    {view.phase === "live" && <span className="parrot-countdown" data-low={view.remaining <= 30 ? "true" : undefined} role="timer" aria-label={`${view.remaining} seconds remaining`}>{Math.floor(view.remaining / 60)}:{String(view.remaining % 60).padStart(2, "0")}</span>}
    </div>
    {live.active && view.playbackBlocked && <button type="button" className="parrot-button" onClick={() => void live.resumeAudio()}>Enable audio</button>}
    <div className="sr-only" aria-live="polite" aria-relevant="text">
      <p>{view.user && `You: ${view.user}`}</p>
      <p>{view.parrot && `Parrot: ${view.parrot}`}</p>
    </div>
    <audio ref={live.audio} autoPlay className="hidden" />
  </div>;
}

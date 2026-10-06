import type { useLiveTalk } from "./useLiveTalk";

export function LiveTalk({ live, disabled }: { live: ReturnType<typeof useLiveTalk>; disabled: boolean }) {
  const { view } = live;
  return <div className="mt-4 min-w-0">
    <div className="flex flex-wrap items-center gap-3">
      {live.active ? <button type="button" className="parrot-button parrot-button--primary" disabled={view.phase === "closing"} onClick={live.end}>
        {view.phase === "closing" ? "Ending conversation…" : "End conversation"}
      </button> : <button type="button" className="parrot-button parrot-button--primary" disabled={disabled} onClick={() => void live.start()}>Talk live</button>}
      {live.active && view.remaining > 0 && <span className="parrot-chip" aria-label={`${view.remaining} seconds remaining`}>{Math.floor(view.remaining / 60)}:{String(view.remaining % 60).padStart(2, "0")}</span>}
    </div>
    <p className="mt-2 text-xs" style={{ color: "var(--ink-2)" }}>Voice is processed by OpenAI. The parrot cannot trade.</p>
    <p className="mt-2 text-sm" aria-live="polite" role="status">{view.status}</p>
    <audio ref={live.audio} autoPlay controls aria-label="Parrot voice playback" className={live.active ? "mt-2 w-full max-w-full" : "hidden"} />
  </div>;
}

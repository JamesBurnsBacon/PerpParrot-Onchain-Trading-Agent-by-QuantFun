import { useEffect, useRef } from "react";
import { useParrotEffects } from "./ParrotEffects";
export type AvatarState = "idle" | "listening" | "thinking" | "speaking";
export function ParrotAvatar({ state, stream, live }: { state: AvatarState; stream?: MediaStream | null; live?: boolean }) {
  const node = useRef<HTMLDivElement>(null);
  const { sfx, quiet } = useParrotEffects();
  useEffect(() => {
    const ctx = sfx.context, el = node.current;
    if (!el || !stream || !live || quiet || !ctx || ctx.state !== "running") return;
    let source: MediaStreamAudioSourceNode | undefined, analyser: AnalyserNode | undefined, frame = 0;
    try {
      source = ctx.createMediaStreamSource(stream); analyser = ctx.createAnalyser(); analyser.fftSize = 256; analyser.smoothingTimeConstant = .8;
      source.connect(analyser); // No destination connection: the audio element alone plays the voice.
      const bins = new Uint8Array(analyser.frequencyBinCount); let level = 0;
      const tick = () => {
        analyser!.getByteFrequencyData(bins);
        const average = bins.reduce((sum, value) => sum + value, 0) / bins.length / 255;
        level += (Math.min(1, average * 3) - level) * .3;
        const bass = bins.slice(0, 10).reduce((sum, value) => sum + value, 0) / 2550;
        el.style.setProperty("--level", level.toFixed(3)); el.style.setProperty("--bass", bass.toFixed(3)); el.dataset.reactive = "true";
        frame = requestAnimationFrame(tick);
      };
      frame = requestAnimationFrame(tick);
    } catch { /* State-based avatar remains the fallback. */ }
    return () => { cancelAnimationFrame(frame); source?.disconnect(); analyser?.disconnect(); delete el.dataset.reactive; el.style.removeProperty("--level"); el.style.removeProperty("--bass"); };
  }, [stream, live, quiet, sfx]);
  return <div ref={node} className={`parrot-avatar parrot-avatar--${state}`}>
    <div className="parrot-halo" aria-hidden="true"><i /><i /><i /></div>
    <div className="parrot-portrait">
      <img src="/parrot.jpg" width={524} height={528} alt="PerpParrot, a friendly green clay parrot with googly eyes, an orange beak, rainbow propeller cap and navy Team RT3 hoodie" />
    </div>
  </div>;
}

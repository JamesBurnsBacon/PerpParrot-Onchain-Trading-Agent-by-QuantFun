"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Fever, ParrotEffectsProvider, useParrotEffects } from "../../../components/parrot/ParrotEffects";
import { ThemeToggle } from "../../../components/parrot/ThemeToggle";
import { WalletBoard, WalletTile } from "../../../components/parrot/WalletBoard";
import { labPresets, labWallet } from "../../../lib/parrot-lab-fixtures";
import { CATALOG_MARKER, findSound, SOUND_CATALOG } from "../../../lib/parrot-sfx-catalog";
import { buildScenario, copyPicks, DEFAULT_PICKS, MOMENTS, type Moment } from "../../../lib/parrot-lab-scenario";
import { diffWallets } from "../../../lib/wallet-board";
import "../parrot.css";
import "./lab.css";

export default function LabClient() {
  return <ParrotEffectsProvider><MaterialsLab /></ParrotEffectsProvider>;
}
export function MaterialsLab() {
  const fx = useParrotEffects();
  const [picks, setPicks] = useState({ ...DEFAULT_PICKS });
  const [audio, setAudio] = useState("Audio is locked. Unlock audio to start.");
  const [active, setActive] = useState<Moment | null>(null);
  const [running, setRunning] = useState(false);
  const [copyStatus, setCopyStatus] = useState("");
  const [flock, setFlock] = useState(0);
  const generation = useRef(0), timers = useRef(new Set<ReturnType<typeof setTimeout>>());
  const clear = useCallback(() => {
    generation.current++;
    for (const timer of timers.current) clearTimeout(timer);
    timers.current.clear(); fx.sfx.cancel();
  }, [fx.sfx]);
  const stop = useCallback(() => { clear(); setRunning(false); setActive(null); }, [clear]);
  useEffect(() => {
    const hide = () => { if (document.hidden) stop(); };
    document.addEventListener("visibilitychange", hide);
    return () => { document.removeEventListener("visibilitychange", hide); clear(); };
  }, [clear, stop]);
  useEffect(() => { stop(); }, [fx.sound, fx.quiet, stop]);
  async function unlock() {
    await fx.sfx.unlock();
    const ready = fx.sfx.context?.state === "running";
    setAudio(ready ? "Audio unlocked. Pick a sound to audition." : "Audio unavailable or blocked. Try Unlock audio again.");
    return ready;
  }
  async function audition(id: string) {
    stop(); const run = generation.current;
    if (!await unlock() || run !== generation.current || document.hidden) return;
    if (!fx.sfx.enabled) { setAudio("Sound is off. Turn Sound on to audition."); return; }
    findSound(id)?.play(fx.sfx.kit());
  }
  async function runScenario() {
    stop(); const run = generation.current;
    if (!await unlock() || run !== generation.current || document.hidden) return;
    const steps = buildScenario(picks, 6, fx.quiet);
    setRunning(true);
    const later = (at: number, action: () => void) => {
      const timer = setTimeout(() => { timers.current.delete(timer); if (generation.current === run) action(); }, at);
      timers.current.add(timer);
    };
    for (const step of steps) later(step.at, () => {
      setActive(step.moment);
      const sound = findSound(step.soundId)!;
      if (sound.cueKind) fx.sfx.kit().cue({ kind: sound.cueKind, at: 0, pitch: step.pitch });
      else sound.play(fx.sfx.kit());
    });
    later(steps.at(-1)!.at + 2000, () => { setRunning(false); setActive(null); });
  }
  async function banner(kind: "strategy" | "clamp" | "lock") {
    stop(); const run = generation.current;
    await unlock();
    if (run === generation.current && !document.hidden) fx.trigger(kind, 6, 1, kind === "clamp");
  }
  async function swap() {
    stop(); const run = generation.current;
    await unlock();
    if (run !== generation.current || document.hidden) return;
    const next = (flock + 1) % labPresets.length;
    const diff = diffWallets(labPresets[flock].chat.shortlist.addresses, labPresets[next].chat.shortlist.addresses);
    setFlock(next); fx.trigger("strategy", labPresets[next].chat.shortlist.addresses.length, diff.removed.length);
  }
  return <main className="parrot-page materials-lab" data-calm={fx.quiet} data-materials={CATALOG_MARKER}>
    <header className="materials-header">
      <div><h1>Materials lab (development only)</h1><p>Audition sounds and effects with synthetic birds. Everything on this page stays local.</p></div>
      <ThemeToggle />
    </header>
    <section aria-label="Lab controls" className="materials-panel">
      <div className="materials-actions">
        <button type="button" onClick={() => void unlock()}>Unlock audio</button>
        <button type="button" onClick={stop}>Stop all sounds</button>
        <button type="button" aria-pressed={fx.calm} onClick={fx.toggleCalm}>Calm {fx.calm ? "on" : "off"}</button>
        <button type="button" aria-pressed={fx.sound} onClick={fx.toggleSound}>Sound {fx.sound ? "on" : "off"}</button>
      </div>
      <p role="status">{audio}</p>
      {fx.reduced && <p>Reduced motion is enabled by your device. Visual effects stay still.</p>}
    </section>
    <section aria-labelledby="scenario-title" className="materials-panel">
      <h2 id="scenario-title">Mock scenario</h2>
      <p>Start → flock arrives / leaves → boundary → reels settle → Locked in. Reel clicks keep their product timing. Picks last only until you leave this page.</p>
      <div className="materials-grid">
        {MOMENTS.map(moment => <label key={moment} className="materials-pick" aria-current={active === moment ? "step" : undefined}>
          <span>{moment}{active === moment ? " ← playing" : ""}</span>
          <select value={picks[moment]} onChange={e => { stop(); setPicks({ ...picks, [moment]: e.target.value }); }}>
            {Array.from(new Set(SOUND_CATALOG.map(s => s.group))).map(group => <optgroup key={group} label={group}>
              {SOUND_CATALOG.filter(s => s.group === group).map(s => <option key={s.id} value={s.id}>{s.label}</option>)}
            </optgroup>)}
          </select>
        </label>)}
      </div>
      <div className="materials-actions">
        <button type="button" onClick={() => void runScenario()}>{running ? "Restart scenario" : "Run scenario"}</button>
        <button type="button" onClick={stop}>Stop scenario</button>
        <button type="button" onClick={async () => {
          try { await navigator.clipboard.writeText(copyPicks(picks)); setCopyStatus("Picks copied."); }
          catch { setCopyStatus("Clipboard unavailable. Select and copy the text below."); }
        }}>Copy my picks</button>
      </div>
      <p role="status">{running ? `Scenario running${active ? `: ${active}` : ""}.` : "Scenario stopped."} {copyStatus}</p>
      <textarea aria-label="My sound picks" readOnly value={copyPicks(picks)} rows={4} />
    </section>
    <section aria-labelledby="sounds-title">
      <h2 id="sounds-title">Sound materials</h2>
      <p>All sounds finish within two seconds. “In use” marks an exact product cue; single layers of a mix are alternatives.</p>
      {Array.from(new Set(SOUND_CATALOG.map(s => s.group))).map(group => <section key={group} aria-label={group}>
        <h3>{group}</h3><div className="materials-grid">
          {SOUND_CATALOG.filter(s => s.group === group).map(s => <article key={s.id} className="materials-panel materials-card">
            <h4>{s.label} {s.usedNow && <span className="materials-badge">in use</span>}</h4>
            <p>{s.goodFor}</p>
            <div className="materials-actions"><button type="button" aria-label={`Play ${s.label}`} onClick={() => void audition(s.id)}>Play</button>
              <button type="button" aria-label={`Stop all sounds (${s.label})`} onClick={stop}>Stop</button></div>
          </article>)}
        </div>
      </section>)}
    </section>
    <section aria-labelledby="visuals-title" className="materials-panel">
      <h2 id="visuals-title">Visual materials</h2>
      <p>Real wallet tiles, stickers and banners, using synthetic examples.</p>
      <div className="materials-moods">{(["calm", "steady", "wild"] as const).map((mood,i) => {
        const evidence = labWallet(i*8);
        return <div key={mood}><h3>{mood}</h3><WalletTile address={evidence.address} evidence={evidence} quiet={fx.quiet} /></div>;
      })}</div>
      <h3>Stickers</h3><div className="materials-moods">{(["new", "removed"] as const).map((change,i) => {
        const evidence = labWallet(i+4);
        return <WalletTile key={change} address={evidence.address} evidence={evidence} quiet={fx.quiet} change={change} />;
      })}</div>
      <h3>Fever banners + feathers</h3>
      <div className="materials-actions">{(["strategy", "clamp", "lock"] as const).map((kind,i) =>
        <button key={kind} type="button" onClick={() => void banner(kind)}>{["STRATEGY SET", "BOUNDED BY CODE", "LOCKED IN"][i]}</button>)}</div>
      <Fever />
      <h3>Mini flock</h3><button type="button" onClick={() => void swap()}>Swap flock</button>
      <p>Synthetic set {flock+1} of {labPresets.length}</p>
      <WalletBoard chat={labPresets[flock].chat} />
    </section>
  </main>;
}

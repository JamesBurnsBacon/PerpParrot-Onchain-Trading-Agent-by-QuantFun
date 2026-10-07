import { useSceneIdentity } from "../art/SceneIdentity";
import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowUpRight, Check, Minus } from "lucide-react";
import { useConductor } from "../art/ConductorProvider";
import type { Source } from "../types";
import { FeatherIdentity, SignalPlumage } from "./FeatherIdentity";
type Props = {
  sources: Source[];
  activeIds: string[];
  selectedId: string;
  onSelect: (id: string) => void;
  onToggle: (id: string) => void;
  onRehearse: (ids: string[]) => void;
  paused?: boolean;
  readOnly?: boolean;
};
const sign = (n: number) =>
  (n < 0 ? "−" : n > 0 ? "+" : "") + Math.abs(n).toFixed(0) + "%";
function contour(index: number, seed: number) {
  let path = "";
  let contourSeed = seed;
  for (let step = 0; step <= index; step++)
    contourSeed = (contourSeed * 1664525 + 1013904223) >>> 0;
  const phase = (contourSeed / 4294967296) * Math.PI * 2;
  for (let i = 0; i <= 160; i++) {
    const a = (i / 160) * Math.PI * 2,
      r =
        77 +
        index * 13 +
        Math.sin(a * 3 + phase) * 23 +
        Math.cos(a * 5 - phase) * 12;
    const x = 510 + Math.cos(a) * r * 1.34,
      y = 190 + Math.sin(a) * r * 0.8;
    path += (i ? "L" : "M") + x.toFixed(2) + " " + y.toFixed(2) + " ";
  }
  return path + "Z";
}
export function PortfolioScore({
  sources,
  activeIds,
  selectedId,
  onSelect,
  onToggle,
  onRehearse,
  paused = false,
  readOnly = false,
}: Props) {
  const conductor = useConductor();
  const scene = useSceneIdentity();
  const unfurl = useRef(1);
  const [focused, setFocused] = useState<string | null>(null),
    [visible, setVisible] = useState(true),
    [documentVisible, setDocumentVisible] = useState(() => !document.hidden),
    element = useRef<HTMLElement>(null);
  const petals = useMemo(
    () => Array.from({ length: 7 }, (_, i) => contour(i, scene.seed)),
    [scene.seed],
  );
  const active = sources.filter((s) => activeIds.includes(s.id)),
    btc = active.reduce((a, s) => a + s.btc, 0),
    eth = active.reduce((a, s) => a + s.eth, 0),
    gross = active.reduce((a, s) => a + Math.abs(s.btc) + Math.abs(s.eth), 0),
    weight = active.reduce((a, s) => a + s.weight, 0);
  useEffect(() => {
    const visibility = () => setDocumentVisible(!document.hidden);
    document.addEventListener("visibilitychange", visibility);
    if (!element.current)
      return () => document.removeEventListener("visibilitychange", visibility);
    const observer = new IntersectionObserver(
      (entries) => setVisible(entries[0].isIntersecting),
      { threshold: 0.05 },
    );
    observer.observe(element.current);
    return () => {
      observer.disconnect();
      document.removeEventListener("visibilitychange", visibility);
    };
  }, []);
  useEffect(() => {
    const subscription = conductor.subscribe(
      (frame) => {
        const bounds = element.current?.getBoundingClientRect();
        if (bounds) {
          const target = Math.max(
            0.18,
            Math.min(
              1,
              (frame.viewport.height - bounds.top) /
                (frame.viewport.height * 0.8),
            ),
          );
          unfurl.current +=
            (target - unfurl.current) * (1 - Math.exp(-frame.delta / 180));
          element.current?.style.setProperty(
            "--plume-unfurl",
            String(unfurl.current),
          );
        }
        element.current?.style.setProperty(
          "--score-local-time",
          String(frame.phase),
        );
        element.current?.style.setProperty(
          "--plume-bank",
          `${Math.sin(frame.phase * 0.65) * 3}deg`,
        );
        element.current?.style.setProperty(
          "--plume-lift",
          `${Math.cos(frame.phase * 0.65) * 7}px`,
        );
      },
      { active: visible && !paused && documentVisible },
    );
    return () => subscription.unsubscribe();
  }, [conductor, visible, paused, documentVisible]);
  return (
    <section
      className={
        "portfolio-score" +
        (paused || !visible || !documentVisible ? " score-still" : "")
      }
      ref={element}
      aria-labelledby="score-title"
    >
      <div className="score-heading">
        <div>
          <span className="score-kicker">
            THE PORTFOLIO SCORE / INTERACTIVE DEMO
          </span>
          <h2 id="score-title">
            Five voices.
            <br />
            <em>One wingbeat.</em>
          </h2>
        </div>
        <p>
          {readOnly ? (
            "Reference demo. Switch to the demo environment to rehearse."
          ) : (
            <>
              Click a voice. Trace its contribution.
              <br />
              Mute it to rehearse a different formation.
            </>
          )}
        </p>
        <span className="score-number">
          03
          <br />
          <small>THE COMPOSITION</small>
        </span>
      </div>
      <div className="score-instrument">
        <div className="score-source-nodes" aria-label="Source contributions">
          {sources.map((s, i) => {
            const included = activeIds.includes(s.id);
            return (
              <div
                key={s.id}
                className={
                  "score-source" +
                  (included ? " included" : " muted") +
                  (selectedId === s.id ? " chosen" : "")
                }
                onPointerEnter={() => setFocused(s.id)}
                onPointerLeave={() => setFocused(null)}
              >
                <button
                  className="score-source-name"
                  disabled={readOnly}
                  aria-label={`${s.name}: weight ${s.weight} percent, BTC ${sign(s.btc)}, ETH ${sign(s.eth)} illustrative equity exposure`}
                  aria-pressed={selectedId === s.id}
                  onFocus={() => setFocused(s.id)}
                  onBlur={() => setFocused(null)}
                  onClick={() => onSelect(s.id)}
                >
                  <span className="score-source-index">
                    <FeatherIdentity id={s.id} index={i} />
                  </span>
                  <span>
                    <strong>{s.name}</strong>
                    <small>{s.weight}% frozen basket weight</small>
                    <small className="score-source-values">
                      <span>₿ {sign(s.btc)}</span>
                      <span>◆ {sign(s.eth)}</span>
                    </small>
                  </span>
                  <ArrowUpRight size={13} />
                </button>
                <button
                  className="score-source-mute"
                  disabled={readOnly}
                  aria-label={
                    (included ? "Exclude " : "Include ") +
                    s.name +
                    " in the synthetic preview"
                  }
                  aria-pressed={included}
                  onFocus={() => setFocused(s.id)}
                  onBlur={() => setFocused(null)}
                  onClick={() => onToggle(s.id)}
                >
                  {included ? <Check size={12} /> : <Minus size={12} />}
                </button>
              </div>
            );
          })}
        </div>
        <div className="score-weave">
          <svg
            viewBox="0 0 1000 390"
            preserveAspectRatio="none"
            aria-hidden="true"
          >
            <defs>
              <linearGradient id="btcEdge">
                <stop stopColor="#9cdacc" />
                <stop offset="1" stopColor="#ffd52a" />
              </linearGradient>
              <linearGradient id="ethEdge">
                <stop stopColor="#8cacff" />
                <stop offset="1" stopColor="#a9c5ff" />
              </linearGradient>
            </defs>
            <g className="spectral-petals" opacity="0.25">
              {petals.map((d, i) => (
                <path
                  key={i}
                  d={d}
                  fill="none"
                  stroke={
                    i % 3 === 0
                      ? "#ffd52a"
                      : i % 3 === 1
                        ? "#ef958c"
                        : "#96b1ff"
                  }
                  strokeWidth=".7"
                  opacity={0.1 + i * 0.025}
                />
              ))}
            </g>
            {sources.flatMap((s, i) => {
              const y = 35 + i * 77,
                enabled = activeIds.includes(s.id),
                highlighted = !focused || focused === s.id;
              return (["btc", "eth"] as const)
                .filter((m) => s[m] !== 0)
                .map((m) => {
                  const target = m === "btc" ? 105 : 285,
                    value = s[m],
                    d = `M0 ${y} C${250 + i * 20} ${y}, ${660 - i * 25} ${target}, 1000 ${target}`;
                  return (
                    <g
                      key={s.id + m}
                      opacity={!enabled ? 0.09 : highlighted ? 0.85 : 0.12}
                    >
                      <path
                        d={d}
                        className={
                          value < 0 ? "score-negative" : "score-positive"
                        }
                        stroke={
                          value < 0
                            ? "#ff9c91"
                            : m === "btc"
                              ? "url(#btcEdge)"
                              : "url(#ethEdge)"
                        }
                        strokeWidth={Math.max(1.4, Math.abs(value) * 0.46)}
                        strokeDasharray={value < 0 ? "8 7" : undefined}
                        fill="none"
                      />
                      <path
                        d={d}
                        className="score-trace"
                        stroke={value < 0 ? "#ffc0b9" : "#fff3ba"}
                        strokeWidth="1.5"
                        strokeDasharray="6 65"
                        fill="none"
                        opacity={enabled && highlighted ? 0.7 : 0}
                      />
                      <text
                        x="850"
                        y={target + (i - 2) * 15}
                        fill={value < 0 ? "#ffafa4" : "#c1d7f3"}
                        fontSize="12"
                      >
                        {value > 0 ? "+" : ""}
                        {value}%
                      </text>
                    </g>
                  );
                });
            })}
          </svg>
          <div className="score-center-mark">
            <SignalPlumage
              sources={sources}
              activeIds={activeIds}
              selectedId={focused ?? selectedId}
            />
            <small>FIVE VOICES / ONE PLUMAGE</small>
          </div>
          <div className="score-weave-foot">
            <span>
              <i className="legend-long" /> Positive contribution
            </span>
            <span>
              <i className="legend-short" /> Negative / offsetting
            </span>
          </div>
        </div>
        <div className="score-market-nodes">
          <div className="score-market btc-market">
            <span>
              <i>₿</i> BTC / NET TARGET
            </span>
            <strong className={btc < 0 ? "coral" : ""}>{sign(btc)}</strong>
            <small>
              {btc < 0
                ? "Modeled short"
                : btc > 0
                  ? "Modeled long"
                  : "Flat target"}{" "}
              / equity exposure
            </small>
          </div>
          <div className="score-market eth-market">
            <span>
              <i>◆</i> ETH / NET TARGET
            </span>
            <strong className={eth < 0 ? "coral" : ""}>{sign(eth)}</strong>
            <small>
              {eth < 0
                ? "Modeled short"
                : eth > 0
                  ? "Modeled long"
                  : "Flat target"}{" "}
              / equity exposure
            </small>
          </div>
        </div>
      </div>
      <div
        className="formation-rehearsal"
        aria-label="Rehearse a synthetic formation"
      >
        <span>YOUR FLOCK. YOUR ARRANGEMENT.</span>
        <button
          disabled={readOnly}
          aria-pressed={activeIds.length === sources.length}
          onClick={() => onRehearse(sources.map((source) => source.id))}
        >
          All five
        </button>
        <button
          disabled={readOnly}
          aria-pressed={
            activeIds.length === sources.length - 1 &&
            !activeIds.includes("quiet")
          }
          onClick={() =>
            onRehearse(
              sources
                .filter((source) => source.id !== "quiet")
                .map((source) => source.id),
            )
          }
        >
          Mute Quiet
        </button>
        <button
          disabled={readOnly}
          aria-pressed={activeIds.length === 1 && activeIds[0] === "quiet"}
          onClick={() => onRehearse(["quiet"])}
        >
          Quiet solo
        </button>
        <small>
          Rehearse signed contributions. These controls change the synthetic
          preview.
        </small>
      </div>
      <div className="score-bottom">
        <div>
          <strong>
            {active.length}
            <span> / {sources.length}</span>
          </strong>
          <p>Active voices</p>
        </div>
        <div>
          <strong>{weight}%</strong>
          <p>Active weight / no renormalization</p>
        </div>
        <div>
          <strong>{gross}%</strong>
          <p>Source gross / before netting</p>
        </div>
        <div>
          <strong>{Math.abs(btc) + Math.abs(eth)}%</strong>
          <p>Netted portfolio gross / 100% demo cap</p>
        </div>
      </div>
      <div className="score-boundary">
        Illustrative signed equity exposure. Muting a source removes its frozen
        contribution; other sources stay unchanged. Preview only.
      </div>
    </section>
  );
}

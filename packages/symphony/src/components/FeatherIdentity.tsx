import { useMemo } from "react";
import type { CSSProperties } from "react";
import { featherFingerprint } from "../art/feather-fingerprint";
import type { Source } from "../types";
import "./feather-identity.css";
const colors = ["#ffe276", "#91d8cf", "#a7baff", "#ffac95", "#edbdff"];
function FeatherPaths({ id }: { id: string }) {
  const geometry = useMemo(() => featherFingerprint(id), [id]);
  return (
    <>
      {geometry.contours.map((d, i) => (
        <path
          key={i}
          d={d}
          fill={i ? "none" : "currentColor"}
          fillOpacity={0.06}
          stroke="currentColor"
          strokeWidth={i ? 0.45 : 1.2}
          opacity={i ? 0.45 : 0.9}
        />
      ))}
      {geometry.barbs.map((d, i) => (
        <path
          key={"b" + i}
          d={d}
          fill="none"
          stroke="currentColor"
          strokeWidth=".5"
          opacity=".38"
        />
      ))}
      <path
        d="M0 9 Q15 -44 0 -108"
        fill="none"
        stroke="currentColor"
        strokeWidth="1"
      />
    </>
  );
}
export function FeatherIdentity({
  id,
  index = 0,
}: {
  id: string;
  index?: number;
}) {
  return (
    <svg
      className="feather-identity"
      viewBox="-42 -119 84 135"
      aria-hidden="true"
      style={{ color: colors[index % colors.length] }}
    >
      <FeatherPaths id={id} />
    </svg>
  );
}
export function SignalPlumage({
  sources,
  activeIds,
  selectedId,
}: {
  sources: Source[];
  activeIds: string[];
  selectedId: string;
}) {
  return (
    <svg className="signal-plumage" viewBox="0 0 360 330" aria-hidden="true">
      <path
        className="plumage-orbit"
        d="M40 240 C-15 85 160 -20 302 65 C410 135 313 340 168 300"
        fill="none"
        stroke="#c8d7ff"
        strokeWidth=".5"
        strokeDasharray="2 9"
      />
      {sources.map((source, index) => (
        <g
          key={source.id}
          transform="translate(180 272)"
          color={colors[index % colors.length]}
        >
          <g
            className={
              "plumage-feather" +
              (activeIds.includes(source.id) ? " is-included" : " is-muted") +
              (selectedId === source.id ? " is-chosen" : "")
            }
            style={
              {
                "--feather-angle": `${(index - 2) * 31}deg`,
                "--feather-lag": `${(index - 2) * 0.8}deg`,
                "--feather-scale": String(1.25 + source.weight / 42),
              } as CSSProperties
            }
          >
            <FeatherPaths id={source.id} />
          </g>
        </g>
      ))}
      <path
        d="M166 286 L180 270 L194 286 M180 270 L180 305"
        fill="none"
        stroke="#ffe276"
        strokeWidth="1.2"
      />
    </svg>
  );
}

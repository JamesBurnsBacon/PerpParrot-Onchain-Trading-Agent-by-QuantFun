export type BadgeKind = "LIVE" | "REPLAY" | "PRECOMPUTED" | "SAMPLE DATA" | "CACHED DEMO";
const descriptions: Record<BadgeKind, string> = {
  LIVE: "Current backend data. This badge does not authorize trading.",
  REPLAY: "Simulated paper-book history, not account execution or a forecast.",
  PRECOMPUTED: "A published artifact computed earlier, not a fresh check of this request.",
  "SAMPLE DATA": "Sample wallets, not a current selection from live wallet data.",
  "CACHED DEMO": "Hand-authored illustration. No model call, verification or server save.",
};
export function Badge({ kind }: { kind: BadgeKind }) {
  return <span className="parrot-badge" data-kind={kind} title={descriptions[kind]}>{kind}</span>;
}

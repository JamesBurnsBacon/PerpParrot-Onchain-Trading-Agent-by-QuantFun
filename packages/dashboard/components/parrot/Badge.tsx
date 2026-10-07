// Sample and cached-demo labels used by Parrot panels and wallet tiles.
// Normal operation has no status badge; labels never imply execution authority.
type BadgeKind = "SAMPLE DATA" | "CACHED DEMO";
const descriptions: Record<BadgeKind, string> = {
  "SAMPLE DATA": "Sample wallets, not a current selection from live wallet data.",
  "CACHED DEMO": "Hand-authored illustration. No model call, verification or server save.",
};
export function Badge({ kind }: { kind: BadgeKind }) {
  return <span className="parrot-badge" data-kind={kind} title={descriptions[kind]}>{kind}</span>;
}

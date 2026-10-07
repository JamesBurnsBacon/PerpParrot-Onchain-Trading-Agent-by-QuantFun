import type { Exposures } from "./data";

export const walletLabel = (address: string, compact = false): string => {
  const head = compact ? 4 : 6;
  const tail = compact ? 3 : 4;
  return address.length > head + tail + 1 ? `${address.slice(0, head)}…${address.slice(-tail)}` : address;
};

// Fractions stay in equity units until presentation. These are already weighted and capped
// by the backend; muting removes attribution only, without renormalizing or reapplying policy.
export function buildExposureFlow(response: Exposures) {
  const wallets = (response.sources ?? []).map((source) => ({
    ...source,
    id: source.address.toLowerCase(),
    label: walletLabel(source.address),
    weightPct: source.weight * 100,
  }));
  // The returned targets are the authority; the contributions only attribute them. An asset only the
  // contributions mention (not expected) falls back to their sum.
  const baseline = new Map(response.exposures.map(({ asset, fraction }) => [asset, fraction]));
  const attributed = new Map<string, number>();
  const bands = wallets.flatMap((wallet) => wallet.contributions.map(({ asset, fraction }) => {
    attributed.set(asset, (attributed.get(asset) ?? 0) + fraction);
    return { wallet: wallet.id, asset, fraction };
  })).filter(({ fraction }) => fraction !== 0);
  for (const [asset, sum] of attributed) if (!baseline.has(asset)) baseline.set(asset, sum);
  return {
    wallets,
    assets: [...baseline].map(([asset, net]) => ({ asset, net }))
      .sort((a, b) => Math.abs(b.net) - Math.abs(a.net) || a.asset.localeCompare(b.asset)),
    bands,
    maxContribution: Math.max(0, ...bands.map(({ fraction }) => Math.abs(fraction))),
  };
}

export type ExposureFlowModel = ReturnType<typeof buildExposureFlow>;

export function targetsWithMutes(model: ExposureFlowModel, muted: ReadonlySet<string>) {
  const excluded = new Set([...muted].map((address) => address.toLowerCase()));
  // The what-if removes the muted wallets' contributions from the returned target.
  const removed = new Map<string, number>();
  for (const band of model.bands) {
    if (excluded.has(band.wallet)) removed.set(band.asset, (removed.get(band.asset) ?? 0) + band.fraction);
  }
  return model.assets.map(({ asset, net: baseline }) => {
    const cut = removed.get(asset) ?? 0;
    return { asset, net: baseline - cut, delta: cut === 0 ? 0 : -cut };
  });
}

// Keep the scale fixed to the unmuted model, so toggles cannot inflate remaining bands.
export function bandWidth(fraction: number, maxContribution: number, maxWidth = 24): number {
  if (fraction === 0 || maxContribution <= 0) return 0;
  return Math.max(1.4, Math.min(1, Math.abs(fraction) / maxContribution) * maxWidth);
}

// Fractions closer to zero than this are float noise from subtracting contributions, not a position.
const NOISE = 1e-9;

// Targets read as a side and a size ("Short 42.7%"), not as a signed number. Only an exact zero is "Flat";
// a real position too small for one decimal reads "<0.1%".
export function sideLabel(fraction: number): string {
  if (Math.abs(fraction) < NOISE) return "Flat";
  const size = (Math.abs(fraction) * 100).toFixed(1);
  return `${fraction > 0 ? "Long" : "Short"} ${size === "0.0" ? "<0.1" : size}%`;
}

// What muting changed, as a move toward long or short.
export function shiftLabel(delta: number): string {
  if (Math.abs(delta) < NOISE) return "no change";
  const size = (Math.abs(delta) * 100).toFixed(1);
  return `${size === "0.0" ? "<0.1" : size} pp more ${delta > 0 ? "long" : "short"}`;
}

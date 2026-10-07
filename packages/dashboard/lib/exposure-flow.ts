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
  const assets = new Map(response.exposures.map(({ asset }) => [asset, 0]));
  const bands = wallets.flatMap((wallet) => wallet.contributions.map(({ asset, fraction }) => {
    assets.set(asset, (assets.get(asset) ?? 0) + fraction);
    return { wallet: wallet.id, asset, fraction };
  })).filter(({ fraction }) => fraction !== 0);
  return {
    wallets,
    assets: [...assets].map(([asset, net]) => ({ asset, net }))
      .sort((a, b) => Math.abs(b.net) - Math.abs(a.net) || a.asset.localeCompare(b.asset)),
    bands,
    maxContribution: Math.max(0, ...bands.map(({ fraction }) => Math.abs(fraction))),
  };
}

export type ExposureFlowModel = ReturnType<typeof buildExposureFlow>;

export function targetsWithMutes(model: ExposureFlowModel, muted: ReadonlySet<string>) {
  const excluded = new Set([...muted].map((address) => address.toLowerCase()));
  const nets = new Map(model.assets.map(({ asset }) => [asset, 0]));
  for (const band of model.bands) {
    if (!excluded.has(band.wallet)) nets.set(band.asset, (nets.get(band.asset) ?? 0) + band.fraction);
  }
  return model.assets.map(({ asset, net: baseline }) => {
    const net = nets.get(asset) ?? 0;
    return { asset, net, delta: net - baseline };
  });
}

// Keep the scale fixed to the unmuted model, so toggles cannot inflate remaining bands.
export function bandWidth(fraction: number, maxContribution: number, maxWidth = 24): number {
  if (fraction === 0 || maxContribution <= 0) return 0;
  return Math.max(1.4, Math.min(1, Math.abs(fraction) / maxContribution) * maxWidth);
}

export function signedExposure(fraction: number): string {
  const magnitude = (Math.abs(fraction) * 100).toFixed(1);
  return `${magnitude === "0.0" ? "" : fraction < 0 ? "−" : "+"}${magnitude}`;
}

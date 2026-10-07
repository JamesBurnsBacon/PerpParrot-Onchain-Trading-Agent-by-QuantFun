import { capGrossExposure, computeExposures, EXPOSURE_SCALE, limitPositions, weightedSourcesFromSnapshot } from "../../../shared/copy";
import type { PositionsSnapshot } from "../../../shared/snapshot";

export type ExposureSource = {
  address: string;
  weight: number;
  contributions: { asset: string; fraction: number }[];
};

// Attribution of FINAL targets, not a second sizing policy. Independent source terms already
// include wind-down caps and leverage normalization. The asset-level final/raw ratio also
// accounts for position limiting and the portfolio gross cap, preserving offsets and signs.
export const exposureBreakdown = (snapshot: PositionsSnapshot): ExposureSource[] => {
  const { sources, maxGrossE9 } = weightedSourcesFromSnapshot(snapshot);
  const raw = computeExposures(sources);
  const rawNet = new Map(raw.map((e) => [e.asset, e.exposureE9]));
  const final = capGrossExposure(limitPositions(raw), maxGrossE9).filter((e) => e.exposureE9 !== 0n);
  return sources.map((source) => {
    const terms = new Map(computeExposures([source]).map((e) => [e.asset, e.exposureE9]));
    return {
      address: source.address,
      weight: source.weightE6 / 1e6,
      contributions: final.flatMap(({ asset, exposureE9 }) => {
        const net = rawNet.get(asset) ?? 0n;
        const term = terms.get(asset) ?? 0n;
        if (net === 0n || term === 0n) return [];
        // Multiply as bigint before conversion; do not truncate each contribution to E9,
        // which would lose small terms and accumulate rounding errors across wallets.
        return [{ asset, fraction: Number(term * exposureE9) / Number(net) / Number(EXPOSURE_SCALE) }];
      }),
    };
  });
};

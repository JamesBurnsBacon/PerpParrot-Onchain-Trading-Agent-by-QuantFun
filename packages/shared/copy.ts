// Pure bigint copy math shared by the backend, the mirror workflow and paper books.
// No imports and no floats, so every DON node computes identical results.
import type { SnapshotSource } from "./snapshot";

const E6 = 1_000_000n;
// Exposures are fractions of our equity × 1e9.
export const EXPOSURE_SCALE = 1_000_000_000n;

// Decimal string → integer × 1e6, truncating extra decimals ("83903.112963" → 83903112963n).
export const decToE6 = (value: string): bigint => {
  const m = /^(-)?(\d+)(?:\.(\d+))?$/.exec(value.trim());
  if (!m) throw new Error(`not a decimal: ${value}`);
  const frac = (m[3] ?? "").slice(0, 6).padEnd(6, "0");
  const abs = BigInt(m[2]) * E6 + BigInt(frac);
  return m[1] ? -abs : abs;
};

type ClearinghouseState = {
  marginSummary: { accountValue: string };
  assetPositions: { position: { coin: string; szi: string; positionValue: string } }[];
};

const abs = (n: bigint) => (n < 0n ? -n : n);

export type AccountState = {
  equityE6: bigint;
  // Signed notional per eligible asset.
  positions: Map<string, bigint>;
};

// Merges HL clearinghouseState responses for each dex into one account view.
export const parseAccount = (states: ClearinghouseState[], eligible: ReadonlySet<string>): AccountState => {
  let equityE6 = 0n;
  const positions = new Map<string, bigint>();
  for (const state of states) {
    equityE6 += decToE6(state.marginSummary.accountValue);
    for (const { position } of state.assetPositions) {
      if (!eligible.has(position.coin)) continue;
      const value = decToE6(position.positionValue);
      const signed = position.szi.startsWith("-") ? -value : value;
      positions.set(position.coin, (positions.get(position.coin) ?? 0n) + signed);
    }
  }
  return { equityE6, positions };
};

export type WeightedSource = SnapshotSource & { weightE6: number; ceilingE6: number };

// Sources holding any eligible position, with positive equity.
const activeSources = (sources: WeightedSource[]) =>
  sources.filter((s) => s.positions.some((p) => BigInt(p.notionalE6) !== 0n) && BigInt(s.equityE6) > 0n);

// Renormalizing over active sources must not push one past its frozen ceiling
// (review core mirror/core.ts: "active-source concentration exceeds ceiling").
export const checkActiveCeilings = (sources: WeightedSource[]): void => {
  const allWeight = BigInt(sources.reduce((sum, s) => sum + s.weightE6, 0));
  const active = activeSources(sources);
  const activeWeight = BigInt(active.reduce((sum, s) => sum + s.weightE6, 0));
  for (const s of active) {
    if (BigInt(s.weightE6) * allWeight > BigInt(s.ceilingE6) * activeWeight) {
      throw new Error(`active-source concentration exceeds ceiling: ${s.address}`);
    }
  }
};

// exposure_c = Σ_i w'_i × n_i,c / E_i (README §4.4). Weights come from the
// manifest and sum to 1 − cash. "Flat is not a signal": flat sources' weight is
// redistributed over sources holding any eligible position, keeping the cash
// share fixed (w'_i = w_i × W_all / W_active). Sorted by asset.
export const computeExposures = (sources: WeightedSource[]): { asset: string; exposureE9: bigint }[] => {
  const allWeight = BigInt(sources.reduce((sum, s) => sum + s.weightE6, 0));
  const active = activeSources(sources);
  const activeWeight = BigInt(active.reduce((sum, s) => sum + s.weightE6, 0));
  const totals = new Map<string, bigint>();
  for (const s of active) {
    const equity = BigInt(s.equityE6);
    for (const p of s.positions) {
      const term =
        (BigInt(s.weightE6) * allWeight * BigInt(p.notionalE6) * EXPOSURE_SCALE) / (equity * activeWeight * E6);
      totals.set(p.asset, (totals.get(p.asset) ?? 0n) + term);
    }
  }
  return [...totals]
    .filter(([, e]) => e !== 0n)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([asset, exposureE9]) => ({ asset, exposureE9 }));
};

// Scales all exposures down pro-rata so gross (Σ |exposure|) ≤ the policy's maxGrossLeverage.
export const capGrossExposure = (
  exposures: { asset: string; exposureE9: bigint }[],
  maxGrossE9: bigint,
): { asset: string; exposureE9: bigint }[] => {
  const gross = exposures.reduce((sum, e) => sum + abs(e.exposureE9), 0n);
  if (gross <= maxGrossE9) return exposures;
  return exposures.map((e) => ({ asset: e.asset, exposureE9: (e.exposureE9 * maxGrossE9) / gross }));
};

// Target notional for our account: exposure × our equity.
export const toTargetE6 = (exposureE9: bigint, equityE6: bigint): bigint => (exposureE9 * equityE6) / EXPOSURE_SCALE;

// Spot-check deviation in basis points of live equity (README §4.7: reject > 5%):
// the larger of Σ_c |snapshot − live notional| (long/short errors can't cancel)
// and |snapshot − live equity|.
export const deviationBps = (snapshot: SnapshotSource, live: AccountState): number => {
  if (live.equityE6 <= 0n) return 10_000;
  const assets = new Set([...snapshot.positions.map((p) => p.asset), ...live.positions.keys()]);
  const snap = new Map(snapshot.positions.map((p) => [p.asset, BigInt(p.notionalE6)]));
  let diff = 0n;
  for (const a of assets) diff += abs((snap.get(a) ?? 0n) - (live.positions.get(a) ?? 0n));
  const equityDiff = abs(BigInt(snapshot.equityE6) - live.equityE6);
  return Number(((diff > equityDiff ? diff : equityDiff) * 10_000n) / live.equityE6);
};

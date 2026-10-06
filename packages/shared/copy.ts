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

const abs = (n: bigint) => (n < 0n ? -n : n);

// exposure_c = Σ_i w'_i × n_i,c / E_i, with w' renormalized over sources that hold
// any eligible position ("flat is not a signal", README §4.4). Sorted by asset.
export const computeExposures = (sources: SnapshotSource[]): { asset: string; exposureE9: bigint }[] => {
  const active = sources.filter((s) => s.positions.some((p) => BigInt(p.notionalE6) !== 0n) && BigInt(s.equityE6) > 0n);
  const activeWeight = BigInt(active.reduce((sum, s) => sum + s.weightE6, 0));
  const totals = new Map<string, bigint>();
  for (const s of active) {
    const equity = BigInt(s.equityE6);
    for (const p of s.positions) {
      const term = (BigInt(s.weightE6) * BigInt(p.notionalE6) * EXPOSURE_SCALE) / (equity * activeWeight);
      totals.set(p.asset, (totals.get(p.asset) ?? 0n) + term);
    }
  }
  return [...totals]
    .filter(([, e]) => e !== 0n)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([asset, exposureE9]) => ({ asset, exposureE9 }));
};

// Target notional for our account: exposure × our equity.
export const toTargetE6 = (exposureE9: bigint, equityE6: bigint): bigint => (exposureE9 * equityE6) / EXPOSURE_SCALE;

// Σ_c |snapshot − live| / live equity, in basis points (README §4.7: reject > 5%).
export const deviationBps = (snapshot: SnapshotSource, live: AccountState): number => {
  if (live.equityE6 <= 0n) return 10_000;
  const assets = new Set([...snapshot.positions.map((p) => p.asset), ...live.positions.keys()]);
  const snap = new Map(snapshot.positions.map((p) => [p.asset, BigInt(p.notionalE6)]));
  let diff = 0n;
  for (const a of assets) diff += abs((snap.get(a) ?? 0n) - (live.positions.get(a) ?? 0n));
  return Number((diff * 10_000n) / live.equityE6);
};

// Pure bigint copy math shared by the backend (targets, paper books), the executor and tests.
// No floats, so the same snapshot always gives the same targets.
import type { PositionsSnapshot, SnapshotSource } from "./snapshot";

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

const abs = (n: bigint) => (n < 0n ? -n : n);

export type AccountState = {
  equityE6: bigint;
  // Signed notional per eligible asset.
  positions: Map<string, bigint>;
};

// caps: a winding-down source's signed leverage cap per perp × 1e9 (snapshot.windDown).
export type WeightedSource = SnapshotSource & { weightE6: number; caps?: Map<string, bigint> };

// exposure_c = Σ_i w_i × n_i,c / E_i (README §4.4). Weights come from the frozen configuration and
// sum to 1 − cash. A wallet's exit is a signal (owner, 2026-10-07): a flat wallet contributes
// nothing, so our exposure in what it held shrinks with it; its weight is not spread over the
// others (which also rescaled every other perp and could push a wallet past its frozen ceiling).
// Sources with no positive equity are skipped. Sorted by asset.
export const computeExposures = (sources: WeightedSource[]): { asset: string; exposureE9: bigint }[] => {
  const totals = new Map<string, bigint>();
  for (const s of sources) {
    const equity = BigInt(s.equityE6);
    if (equity <= 0n) continue;
    for (const p of s.positions) {
      const notional = s.caps ? cappedNotional(BigInt(p.notionalE6), s.caps.get(p.asset), equity) : BigInt(p.notionalE6);
      if (notional === 0n) continue;
      const term = (BigInt(s.weightE6) * notional * EXPOSURE_SCALE) / (equity * E6);
      totals.set(p.asset, (totals.get(p.asset) ?? 0n) + term);
    }
  }
  return [...totals]
    .filter(([, e]) => e !== 0n)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([asset, exposureE9]) => ({ asset, exposureE9 }));
};

// A winding-down source's position within its cap: same sign as the cap and no larger than
// |cap| × equity; a perp with no cap, or held the other way, isn't followed.
export const cappedNotional = (notionalE6: bigint, capE9: bigint | undefined, equityE6: bigint): bigint => {
  if (capE9 === undefined || capE9 === 0n || notionalE6 === 0n || (notionalE6 < 0n) !== (capE9 < 0n)) return 0n;
  const limit = (abs(capE9) * equityE6) / EXPOSURE_SCALE;
  return abs(notionalE6) <= limit ? notionalE6 : notionalE6 < 0n ? -limit : limit;
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

// A run's target exposures (README §4.4): every source must be in the frozen configuration and hold
// only eligible assets, each contributes at its frozen weight, and gross is capped at the policy's
// maxGrossLeverage. Used for the executor's targets and the paper books.
export const targetsFromSnapshot = (snapshot: PositionsSnapshot): { asset: string; exposureE9: bigint }[] => {
  const frozen = new Map(snapshot.configuration.sources.map((s) => [s.sourceAddress.toLowerCase(), s]));
  const eligible = new Set(snapshot.eligibleAssets);
  for (const s of snapshot.sources) {
    if (!frozen.has(s.address)) throw new Error(`source ${s.address} is not in the frozen configuration`);
    for (const p of s.positions) if (!eligible.has(p.asset)) throw new Error(`ineligible asset in snapshot: ${p.asset}`);
  }
  const caps = new Map((snapshot.windDown ?? []).map((w) => [w.address.toLowerCase(), new Map(w.caps.map((c) => [c.asset, BigInt(c.leverageE9)]))]));
  for (const address of caps.keys()) if (!frozen.has(address)) throw new Error(`winding-down source ${address} is not in the frozen configuration`);
  const sources = snapshot.sources.map((s) => ({ ...s, weightE6: frozen.get(s.address)!.weightUnits, caps: caps.get(s.address) }));
  const maxGrossE9 = BigInt(Math.round(snapshot.configuration.policy.maxGrossLeverage * Number(EXPOSURE_SCALE)));
  return capGrossExposure(computeExposures(sources), maxGrossE9);
};

// Closes wait for confirmation (owner, 2026-10-07): a perp whose target went to 0 is closed only once
// its target has been 0 for CLOSE_CONFIRM_RUNS runs in a row (~30 min), so a wallet that exits and
// re-enters within that time costs no round trip. Reductions to a nonzero target are not delayed.
export const CLOSE_CONFIRM_RUNS = 3;

// The perps whose close is still pending at this run: targeted (nonzero) in one of the previous
// CLOSE_CONFIRM_RUNS − 1 runs and at 0 now. `previous` holds those runs' targets, newest first;
// undefined for a run without a snapshot (it counts as a run at 0). Sorted.
export const pendingCloses = (
  current: { asset: string; exposureE9: bigint }[],
  previous: ({ asset: string; exposureE9: bigint }[] | undefined)[],
): string[] => {
  const now = new Set(current.filter((e) => e.exposureE9 !== 0n).map((e) => e.asset));
  const pending = new Set<string>();
  for (const run of previous.slice(0, CLOSE_CONFIRM_RUNS - 1)) {
    for (const e of run ?? []) if (e.exposureE9 !== 0n && !now.has(e.asset)) pending.add(e.asset);
  }
  return [...pending].sort();
};

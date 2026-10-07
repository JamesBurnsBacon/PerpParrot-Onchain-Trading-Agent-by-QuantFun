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
// scaleE6: its leverage normalization × 1e6 (snapshot.leverage); maxGrossE9: the most its scaled book
// may count for, as leverage × 1e9 (the policy's gross cap).
export type WeightedSource = SnapshotSource & { weightE6: number; caps?: Map<string, bigint>; scaleE6?: bigint; maxGrossE9?: bigint };

// Leverage normalization (owner, 2026-10-07): each wallet counts at TARGET_WALLET_LEVERAGE per unit
// of weight on a usual day, whatever leverage it usually runs, so a 0.1× vault and a 3× trader weigh
// alike, while a wallet running above or below its own average (risk-on, de-risking, exiting) still
// moves our exposure. Averages under MIN_AVERAGE_LEVERAGE are floored there, so a nearly flat
// wallet isn't blown up 100×; an unknown average leaves the wallet as it is.
export const TARGET_WALLET_LEVERAGE = 2;
export const MIN_AVERAGE_LEVERAGE = 0.05;
export const leverageScaleE6 = (averageLeverage: number | null | undefined): string | null =>
  averageLeverage === null || averageLeverage === undefined || !Number.isFinite(averageLeverage) || averageLeverage < 0
    ? null
    : String(Math.round((TARGET_WALLET_LEVERAGE / Math.max(averageLeverage, MIN_AVERAGE_LEVERAGE)) * 1e6));

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
    const held = s.positions
      .map((p) => ({ asset: p.asset, notional: s.caps ? cappedNotional(BigInt(p.notionalE6), s.caps.get(p.asset), equity) : BigInt(p.notionalE6) }))
      .filter((p) => p.notional !== 0n);
    // Normalized, but never counting for more than the policy's gross cap on its own (counted the same
    // way: hedged minority at half): past it, the wallet's book is scaled to exactly the cap.
    const scale = s.scaleE6 ?? E6;
    const heldGross = countedGross(held.map((p) => p.notional)); // as the policy cap counts it
    const capped = s.scaleE6 !== undefined && s.maxGrossE9 !== undefined && heldGross * scale * EXPOSURE_SCALE > s.maxGrossE9 * equity * E6;
    for (const p of held) {
      const term = capped
        ? (BigInt(s.weightE6) * p.notional * s.maxGrossE9!) / (heldGross * E6)
        : (BigInt(s.weightE6) * p.notional * scale * EXPOSURE_SCALE) / (equity * E6 * E6);
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

// What counts against the gross cap (owner, 2026-10-07): offsetting longs and shorts are partly
// hedged, so the side in the minority counts at half its value: majority + ½ × minority, each side
// summed over perps. 3× long and 2× short count 4×; 3× long and nothing short count 3×.
export const countedGross = (signed: bigint[]): bigint => {
  let long = 0n;
  let short = 0n;
  for (const x of signed) {
    if (x > 0n) long += x;
    else short -= x;
  }
  return long >= short ? long + short / 2n : short + long / 2n;
};

// At most MAX_POSITIONS perps (owner, 2026-10-07: the book holds 5–15 positions): keep the largest by
// |exposure| and scale them up so the counted gross is unchanged; the rest go to 0 (their closes
// still wait for confirmation, so a perp hovering at the edge doesn't churn). Ties by asset name.
export const MAX_POSITIONS = 15;
export const limitPositions = (
  exposures: { asset: string; exposureE9: bigint }[],
  max = MAX_POSITIONS,
): { asset: string; exposureE9: bigint }[] => {
  const held = exposures.filter((e) => e.exposureE9 !== 0n);
  if (held.length <= max) return exposures;
  const kept = [...held].sort((a, b) => (abs(b.exposureE9) > abs(a.exposureE9) ? 1 : abs(b.exposureE9) < abs(a.exposureE9) ? -1 : a.asset < b.asset ? -1 : 1)).slice(0, max);
  const before = countedGross(held.map((e) => e.exposureE9));
  const after = countedGross(kept.map((e) => e.exposureE9));
  return kept
    .map((e) => ({ asset: e.asset, exposureE9: after > 0n ? (e.exposureE9 * before) / after : e.exposureE9 }))
    .sort((a, b) => (a.asset < b.asset ? -1 : 1));
};

// Scales all exposures down pro-rata so the counted gross ≤ the policy's maxGrossLeverage.
export const capGrossExposure = (
  exposures: { asset: string; exposureE9: bigint }[],
  maxGrossE9: bigint,
): { asset: string; exposureE9: bigint }[] => {
  const gross = countedGross(exposures.map((e) => e.exposureE9));
  if (gross <= maxGrossE9) return exposures;
  return exposures.map((e) => ({ asset: e.asset, exposureE9: (e.exposureE9 * maxGrossE9) / gross }));
};

// Validate and weight the snapshot once, shared by targets and their per-source attribution.
export const weightedSourcesFromSnapshot = (snapshot: PositionsSnapshot): { sources: WeightedSource[]; maxGrossE9: bigint } => {
  const frozen = new Map(snapshot.configuration.sources.map((s) => [s.sourceAddress.toLowerCase(), s]));
  const eligible = new Set(snapshot.eligibleAssets);
  for (const s of snapshot.sources) {
    if (!frozen.has(s.address)) throw new Error(`source ${s.address} is not in the frozen configuration`);
    for (const p of s.positions) if (!eligible.has(p.asset)) throw new Error(`ineligible asset in snapshot: ${p.asset}`);
  }
  const caps = new Map((snapshot.windDown ?? []).map((w) => [w.address.toLowerCase(), new Map(w.caps.map((c) => [c.asset, BigInt(c.leverageE9)]))]));
  for (const address of caps.keys()) if (!frozen.has(address)) throw new Error(`winding-down source ${address} is not in the frozen configuration`);
  const scales = new Map((snapshot.leverage ?? []).map((l) => [l.address.toLowerCase(), BigInt(l.scaleE6)]));
  for (const [address, scale] of scales) {
    if (!frozen.has(address)) throw new Error(`normalized source ${address} is not in the frozen configuration`);
    if (scale <= 0n) throw new Error(`invalid leverage scale for ${address}`);
  }
  const maxGrossE9 = BigInt(Math.round(snapshot.configuration.policy.maxGrossLeverage * Number(EXPOSURE_SCALE)));
  const sources = snapshot.sources.map((s) => ({
    ...s,
    weightE6: frozen.get(s.address)!.weightUnits,
    caps: caps.get(s.address),
    ...(scales.has(s.address) ? { scaleE6: scales.get(s.address)!, maxGrossE9 } : {}),
  }));
  return { sources, maxGrossE9 };
};

// A run's target exposures (README §4.4): every source must be in the frozen configuration and hold
// only eligible assets, each contributes at its frozen weight (normalized to the target leverage when
// the snapshot lists it), at most 15 perps are kept, and gross is capped at the policy's maxGrossLeverage. Used for the executor's targets and the paper books.
export const targetsFromSnapshot = (snapshot: PositionsSnapshot): { asset: string; exposureE9: bigint }[] => {
  const { sources, maxGrossE9 } = weightedSourcesFromSnapshot(snapshot);
  return capGrossExposure(limitPositions(computeExposures(sources)), maxGrossE9);
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

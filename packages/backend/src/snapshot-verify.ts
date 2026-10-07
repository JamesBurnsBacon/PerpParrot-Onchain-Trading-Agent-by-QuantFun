// A second opinion on a mirror run's positions snapshot (README "NOWNodes"; SNAPSHOT_VERIFY=on|strict).
//
// After the snapshot's reads, every source's perp positions are read again from NOWNodes' copy of the info API
// and compared, asset by asset, with what the snapshot recorded. This catches a provider-side fault (a stale or
// partial answer) before the executor sizes orders from it. It is a second delivery path to the same
// Hyperliquid state, not an independent data source: it cannot catch an error Hyperliquid itself makes.
//
//   verified     every source agrees within tolerance
//   mismatch     a source still differs after both providers were read again: the snapshot is not stored,
//                the run fails (the executor records it and alerts; the next run tries again)
//   unverified   NOWNodes could not be read for some source: stored as usual under SNAPSHOT_VERIFY=on,
//                refused under =strict (the reliability of the second opinion must not stop trading by default)
//
// The outcome is not part of the snapshot (its bytes are hashed and immutable); it goes to the log and to
// verificationStats(), which /pipeline serves.
import { positionsOf, type PerpState } from "../../shared/account";
import { ELIGIBLE_DEXES, type PositionsSnapshot } from "../../shared/snapshot";
import { NOWNODES_URL } from "./pipeline/info-router";

export type PerpReader = (user: string, dex: string) => Promise<PerpState>;
export type VerifyMode = "off" | "on" | "strict";
export type Diff = { address: string; asset: string; snapshotE6: string; secondE6: string };
export type VerifyOutcome = { verdict: "verified" | "mismatch" | "unverified"; sources: number; diffs: Diff[]; unverified: string[]; retried: number; ms: number };

export type VerifyOptions = {
  mode: Exclude<VerifyMode, "off">;
  second: PerpReader; // NOWNodes
  official: PerpReader; // re-read when the first comparison differs
  tolerancePct?: number; // default 1
  toleranceFloorE6?: bigint; // default $5
  now?: () => number;
  log?: (msg: string, data?: Record<string, unknown>) => void;
};

const abs = (n: bigint) => (n < 0n ? -n : n);
const MAX_DIFFS_KEPT = 8;
const MAX_TOLERANCE_PCT = 50;

// "on" without a key stays off (the feature is optional); "strict" without a key is a configuration error, not a
// silently disabled gate.
export const verifyMode = (value: string | undefined, key: string | undefined): VerifyMode => {
  if (value === "strict" && !key) throw new Error("SNAPSHOT_VERIFY=strict requires NOWNODES_API_KEY");
  return key && (value === "on" || value === "strict") ? value : "off";
};

// Reads one account's perp states from NOWNodes. The key is sent in a header and never follows a redirect.
export const nownodesPerp = (key: string, fetchImpl: typeof fetch = fetch, timeoutMs = 10_000): PerpReader => async (user, dex) => {
  const res = await fetchImpl(NOWNODES_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", "api-key": key },
    body: JSON.stringify({ type: "clearinghouseState", user, ...(dex ? { dex } : {}) }),
    redirect: "error",
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`NOWNodes clearinghouseState failed: ${res.status}`);
  return (await res.json()) as PerpState;
};

const read = async (reader: PerpReader, address: string, eligible: ReadonlySet<string>) =>
  positionsOf(await Promise.all(ELIGIBLE_DEXES.map((dex) => reader(address, dex))), eligible);

// Assets whose two readings differ by more than max(floor, pct of the larger). A missing asset counts as 0.
const differing = (a: Map<string, bigint>, b: Map<string, bigint>, pct: number, floorE6: bigint) => {
  const out: { asset: string; a: bigint; b: bigint }[] = [];
  for (const asset of new Set([...a.keys(), ...b.keys()])) {
    const x = a.get(asset) ?? 0n;
    const y = b.get(asset) ?? 0n;
    const larger = abs(x) > abs(y) ? abs(x) : abs(y);
    const allowed = (larger * BigInt(Math.round(pct * 1000))) / 100_000n;
    if (abs(x - y) > (allowed > floorE6 ? allowed : floorE6)) out.push({ asset, a: x, b: y });
  }
  return out.sort((p, q) => (p.asset < q.asset ? -1 : 1));
};

export type VerificationStats = {
  mode: VerifyMode;
  checks: number;
  verified: number;
  mismatches: number;
  unverified: number;
  last: (VerifyOutcome & { at: number }) | null;
};

const EMPTY: VerificationStats = { mode: "off", checks: 0, verified: 0, mismatches: 0, unverified: 0, last: null };
let stats: VerificationStats = EMPTY;
const record = (outcome: VerifyOutcome, mode: VerifyMode, at: number) => {
  stats = {
    mode,
    checks: stats.checks + 1,
    verified: stats.verified + (outcome.verdict === "verified" ? 1 : 0),
    mismatches: stats.mismatches + (outcome.verdict === "mismatch" ? 1 : 0),
    unverified: stats.unverified + (outcome.verdict === "unverified" ? 1 : 0),
    last: { ...outcome, at },
  };
};
export const verificationStats = (): VerificationStats => stats;
export const resetVerificationStats = () => {
  stats = EMPTY;
};

export const verifySnapshot = async (snapshot: PositionsSnapshot, o: VerifyOptions): Promise<VerifyOutcome> => {
  const now = o.now ?? Date.now;
  const started = now();
  // A bad SNAPSHOT_VERIFY_TOLERANCE_PCT (NaN, 0, negative, or so large that it would accept a missing position)
  // falls back to the default instead of breaking every build or silently disabling the check.
  const pct = o.tolerancePct !== undefined && Number.isFinite(o.tolerancePct) && o.tolerancePct > 0 && o.tolerancePct <= MAX_TOLERANCE_PCT ? o.tolerancePct : 1;
  const floor = o.toleranceFloorE6 ?? 5_000_000n;
  const eligible = new Set(snapshot.eligibleAssets);
  const diffs: Diff[] = [];
  const unverified: string[] = [];
  let retried = 0;

  await Promise.all(
    snapshot.sources.map(async (source) => {
      const recorded = new Map(source.positions.map((p) => [p.asset, BigInt(p.notionalE6)]));
      let second: Map<string, bigint>;
      try {
        second = await read(o.second, source.address, eligible);
      } catch (e) {
        unverified.push(source.address);
        o.log?.("snapshot verify: NOWNodes read failed", { address: source.address, error: (e as Error).message });
        return;
      }
      if (differing(recorded, second, pct, floor).length === 0) return;
      // The two reads were seconds apart and positions move: read both again before calling it a mismatch.
      retried++;
      try {
        const [again, secondAgain] = await Promise.all([read(o.official, source.address, eligible), read(o.second, source.address, eligible)]);
        // Two fresh reads that agree with each other are not enough: they must also agree with what the snapshot
        // recorded, or a stale first read would be approved. A snapshot both providers now contradict is refused
        // (the executor retries and the rebuilt snapshot reads current positions).
        const betweenProviders = differing(again, secondAgain, pct, floor);
        const againstSnapshot = betweenProviders.length ? [] : differing(recorded, again, pct, floor);
        for (const d of [...betweenProviders, ...againstSnapshot]) diffs.push({ address: source.address, asset: d.asset, snapshotE6: d.a.toString(), secondE6: d.b.toString() });
      } catch {
        unverified.push(source.address); // could not settle it: not a confirmed mismatch
      }
    }),
  );

  diffs.sort((p, q) => (p.address + p.asset < q.address + q.asset ? -1 : 1));
  unverified.sort();
  const verdict = diffs.length ? "mismatch" : unverified.length ? "unverified" : "verified";
  const outcome: VerifyOutcome = { verdict, sources: snapshot.sources.length, diffs: diffs.slice(0, MAX_DIFFS_KEPT), unverified, retried, ms: now() - started };
  record(outcome, o.mode, now());
  return outcome;
};

// Whether the outcome stops the run: a confirmed mismatch always, an unverified source only under "strict".
export const blocks = (outcome: VerifyOutcome, mode: Exclude<VerifyMode, "off">) => outcome.verdict === "mismatch" || (mode === "strict" && outcome.verdict === "unverified");

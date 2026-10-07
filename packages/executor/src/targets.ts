// A run's targets (README §4.7): the backend reads the frozen sources' positions from Hyperliquid
// and turns them into target exposures (shared/copy.ts targetsFromSnapshot); the executor sizes
// them with our live equity and trades. On Vercel the backend is reached over the service binding
// BACKEND_URL (vercel.json); locally it is the backend's own URL.
import type { Hex } from "viem";

export type Targets = {
  runId: string;
  runAt: number;
  // keccak256 of the positions snapshot the targets came from (GET /snapshots/:runAt).
  snapshotHash: Hex;
  configurationHash: Hex;
  account: Hex;
  // Signed target notional as a fraction of our equity × 1e9 (−0.5 = short half our equity).
  exposures: { asset: string; exposureE9: bigint }[];
};

export type TargetSource = (runAt: number) => Promise<Targets>;

const HASH = /^0x[0-9a-f]{64}$/;
const ADDRESS = /^0x[0-9a-f]{40}$/;
const INTEGER = /^-?\d{1,40}$/;

// Strict: anything unexpected fails the run rather than trading on a misread.
export const parseTargets = (value: unknown, runAt: number): Targets => {
  const t = value as Record<string, unknown>;
  if (!t || typeof t !== "object" || Array.isArray(t)) throw new Error("targets: not an object");
  if (t.runAt !== runAt || t.runId !== `mirror-${runAt}`) throw new Error(`targets are for run ${String(t.runAt)}, expected ${runAt}`);
  for (const field of ["snapshotHash", "configurationHash"] as const) {
    if (typeof t[field] !== "string" || !HASH.test(t[field] as string)) throw new Error(`targets: invalid ${field}`);
  }
  if (typeof t.account !== "string" || !ADDRESS.test(t.account)) throw new Error("targets: invalid account");
  if (!Array.isArray(t.exposures)) throw new Error("targets: exposures must be a list");
  const seen = new Set<string>();
  const exposures = t.exposures.map((e: { asset?: unknown; exposureE9?: unknown }) => {
    if (typeof e?.asset !== "string" || !/^[A-Za-z0-9:_-]{1,64}$/.test(e.asset) || seen.has(e.asset)) throw new Error("targets: invalid or duplicate asset");
    if (typeof e.exposureE9 !== "string" || !INTEGER.test(e.exposureE9)) throw new Error(`targets: invalid exposure for ${e.asset}`);
    seen.add(e.asset);
    return { asset: e.asset, exposureE9: BigInt(e.exposureE9) };
  });
  return { runId: t.runId as string, runAt, snapshotHash: t.snapshotHash as Hex, configurationHash: t.configurationHash as Hex, account: t.account as Hex, exposures };
};

export const backendTargets = (backendUrl: string, fetchImpl: typeof fetch = fetch): TargetSource => async (runAt) => {
  const url = new URL(`targets/${runAt}`, backendUrl.endsWith("/") ? backendUrl : `${backendUrl}/`);
  // Generous: the first request for a run may build its snapshot (one HL read per source).
  const res = await fetchImpl(url, { signal: AbortSignal.timeout(45_000) }).catch((e: Error) => {
    throw new Error(`backend targets for ${runAt}: ${e.message}`);
  });
  if (!res.ok) throw new Error(`backend targets for ${runAt}: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
  return parseTargets(await res.json(), runAt);
};

// Run slots are the :x0 boundaries, 10 minutes apart (README §4.7).
export const RUN_INTERVAL_SECONDS = 600;

// The run a trigger at `nowMs` is for: the latest :x0, if it passed at most `graceSeconds` ago
// (a cron call or timer tick that comes late is still on time; one that comes very late is not).
export const dueRunAt = (nowMs: number, graceSeconds = 120): number | null => {
  const now = Math.floor(nowMs / 1000);
  const runAt = now - (now % RUN_INTERVAL_SECONDS);
  return now - runAt <= graceSeconds ? runAt : null;
};

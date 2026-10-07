import type { EligibilityTracker } from "./eligibility";
import type { ConfigurationSource } from "./configuration-source";
import type { HlReader } from "./hyperliquid";
import { buildSnapshot, type SnapshotStore } from "./snapshot";
import { blocks, verifySnapshot, type VerifyOptions } from "./snapshot-verify";
import { CLOSE_CONFIRM_RUNS, leverageScaleE6, pendingCloses, targetsFromSnapshot } from "../../shared/copy";
import type { PositionsSnapshot, WindDownSource } from "../../shared/snapshot";

export const RUN_INTERVAL_SECONDS = 600;

// The mirror run a snapshot built now is for: the next :x0 boundary.
export const nextRunAt = (nowSeconds: number) => Math.ceil((nowSeconds + 1) / RUN_INTERVAL_SECONDS) * RUN_INTERVAL_SECONDS;

export type SnapshotServiceDeps = {
  configurations: ConfigurationSource;
  eligibility: EligibilityTracker;
  store: SnapshotStore;
  nowMs: () => number;
  hl?: HlReader;
  // Build only this close to the run (default 120 s): a snapshot built earlier would be
  // stale at run time. 600 for local end-to-end runs, which ask for the next :x0 early.
  maxLeadSeconds?: number;
  // Refuse to build snapshots for runs that are this far in the past.
  maxLagSeconds?: number;
  // Caps of the sources winding down (roster_seats), recorded in the snapshot (ROSTER.md §4.4).
  windDown?: () => Promise<WindDownSource[]>;
  // Each seated wallet's 30-day average leverage (roster_seats), for the snapshot's normalization.
  leverage?: () => Promise<{ address: string; averageLeverage: number | null }[]>;
  // Cross-check each snapshot against NOWNodes before it is stored (absent: no check; see snapshot-verify.ts).
  verify?: VerifyOptions;
  // Called once per run after its snapshot is stored (paper books step here).
  onBuilt?: (runAt: number, json: string) => Promise<void>;
};

export class SnapshotService {
  private readonly building = new Map<number, Promise<string>>();

  constructor(private readonly deps: SnapshotServiceDeps) {}

  // Returns the stored snapshot for runAt, building it once if needed. Concurrent
  // requests (the :x9 cron, the executor, the dashboard) share one build. Only real run times (:x0
  // boundaries) close to now can be built, so the public endpoint can't be used to
  // pre-build a stale snapshot for a future run or to burn our HL rate limit.
  async get(runAt: number): Promise<string> {
    if (runAt % RUN_INTERVAL_SECONDS !== 0) throw new SnapshotError(404, `${runAt} is not a mirror run time`);
    const stored = await this.deps.store.get(runAt);
    if (stored) return stored;

    const nowSeconds = Math.floor(this.deps.nowMs() / 1000);
    const lead = this.deps.maxLeadSeconds ?? 120;
    const lag = this.deps.maxLagSeconds ?? 120;
    if (runAt > nowSeconds + lead) throw new SnapshotError(404, `run ${runAt} is too far ahead`);
    if (runAt < nowSeconds - lag) throw new SnapshotError(404, `run ${runAt} has no snapshot`);

    let build = this.building.get(runAt);
    if (!build) {
      build = this.build(runAt).finally(() => this.building.delete(runAt));
      this.building.set(runAt, build);
    }
    return build;
  }

  private async build(runAt: number): Promise<string> {
    const nowMs = this.deps.nowMs();
    const configuration = await this.deps.configurations.load(nowMs);
    const eligible = await this.deps.eligibility.current(nowMs);
    const snapshot: PositionsSnapshot = await buildSnapshot(configuration, eligible, runAt, this.deps.nowMs, this.deps.hl);
    // SNAPSHOT_VERIFY: a second read of every source from NOWNodes. A confirmed mismatch stores nothing and fails
    // the run (the executor alerts and the next run rebuilds); see snapshot-verify.ts.
    if (this.deps.verify) {
      const outcome = await verifySnapshot(snapshot, this.deps.verify);
      if (blocks(outcome, this.deps.verify.mode)) {
        const what = outcome.diffs.length
          ? `${outcome.diffs.length} position(s) differ, e.g. ${outcome.diffs[0]!.address} ${outcome.diffs[0]!.asset}`
          : `${outcome.unverified.length} source(s) could not be read from NOWNodes`;
        throw new SnapshotError(503, `snapshot for run ${runAt} failed the NOWNodes cross-check (${outcome.verdict}): ${what}`);
      }
    }
    // Only sources in this configuration, and only perps it lists, sorted: the JSON stays canonical.
    const inConfiguration = new Set(configuration.sources.map((s) => s.sourceAddress.toLowerCase()));
    const windDown = (await this.deps.windDown?.() ?? [])
      .filter((w) => inConfiguration.has(w.address.toLowerCase()))
      .map((w) => ({ address: w.address.toLowerCase(), caps: [...w.caps].sort((a, b) => (a.asset < b.asset ? -1 : 1)) }))
      .sort((a, b) => (a.address < b.address ? -1 : 1));
    if (windDown.length) snapshot.windDown = windDown;
    const leverage = (await this.deps.leverage?.() ?? [])
      .filter((l) => inConfiguration.has(l.address.toLowerCase()))
      .flatMap((l) => {
        const scaleE6 = leverageScaleE6(l.averageLeverage);
        return scaleE6 === null ? [] : [{ address: l.address.toLowerCase(), scaleE6 }];
      })
      .sort((a, b) => (a.address < b.address ? -1 : 1));
    if (leverage.length) snapshot.leverage = leverage;
    const json = await this.deps.store.putIfAbsent(runAt, JSON.stringify(snapshot));
    // After serving starts, so a slow hook never delays the executor's run.
    if (this.deps.onBuilt) queueMicrotask(() => void this.deps.onBuilt!(runAt, json).catch(() => undefined));
    return json;
  }

  // The perps whose close is still pending at runAt (shared/copy.ts pendingCloses), from the stored
  // snapshots of the previous runs: read only, never built. One that can't be read counts as a run at 0.
  async pendingCloses(runAt: number, current: { asset: string; exposureE9: bigint }[]): Promise<string[]> {
    const previous = await Promise.all(
      Array.from({ length: CLOSE_CONFIRM_RUNS - 1 }, async (_, i) => {
        try {
          const json = await this.deps.store.get(runAt - (i + 1) * RUN_INTERVAL_SECONDS);
          return json ? targetsFromSnapshot(JSON.parse(json) as PositionsSnapshot) : undefined;
        } catch {
          return undefined;
        }
      }),
    );
    return pendingCloses(current, previous);
  }

  // Scheduler tick: at :x9 build the snapshot for the coming :x0 run (README §4.7).
  async tick(): Promise<number | undefined> {
    const nowSeconds = Math.floor(this.deps.nowMs() / 1000);
    const runAt = nextRunAt(nowSeconds);
    if (runAt - nowSeconds > 90) return undefined;
    await this.get(runAt);
    return runAt;
  }
}

export class SnapshotError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

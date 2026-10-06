import type { EligibilityTracker } from "./eligibility";
import type { ConfigurationSource } from "./configuration-source";
import type { HlReader } from "./hyperliquid";
import { buildSnapshot, type SnapshotStore } from "./snapshot";

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
  // stale at run time, and every node would reject it. 600 for `cre workflow simulate`,
  // which stamps the next :x0.
  maxLeadSeconds?: number;
  // Refuse to build snapshots for runs that are this far in the past.
  maxLagSeconds?: number;
};

export class SnapshotService {
  private readonly building = new Map<number, Promise<string>>();

  constructor(private readonly deps: SnapshotServiceDeps) {}

  // Returns the stored snapshot for runAt, building it once if needed. Concurrent
  // requests (one per DON node) share the same build. Only real run times (:x0
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
    const snapshot = await buildSnapshot(configuration, eligible, runAt, this.deps.nowMs, this.deps.hl);
    return this.deps.store.putIfAbsent(runAt, JSON.stringify(snapshot));
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

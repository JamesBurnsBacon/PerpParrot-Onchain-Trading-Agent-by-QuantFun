import type { EligibilityTracker } from "./eligibility";
import type { ConfigurationSource } from "./configuration-source";
import { buildSnapshot, type ReadAccount, type SnapshotStore } from "./snapshot";

export const RUN_INTERVAL_SECONDS = 600;

// The mirror run a snapshot built now is for: the next :x0 boundary.
export const nextRunAt = (nowSeconds: number) => Math.ceil((nowSeconds + 1) / RUN_INTERVAL_SECONDS) * RUN_INTERVAL_SECONDS;

export type SnapshotServiceDeps = {
  configurations: ConfigurationSource;
  eligibility: EligibilityTracker;
  store: SnapshotStore;
  nowMs: () => number;
  readAccount?: ReadAccount;
  // Refuse to build snapshots for runs further out than this (stops arbitrary runAt spam).
  maxLeadSeconds?: number;
  // Refuse to build snapshots for runs that are this far in the past.
  maxLagSeconds?: number;
};

export class SnapshotService {
  private readonly building = new Map<number, Promise<string>>();

  constructor(private readonly deps: SnapshotServiceDeps) {}

  // Returns the stored snapshot for runAt, building it once if needed. Concurrent
  // requests (one per DON node) share the same build.
  async get(runAt: number): Promise<string> {
    const stored = await this.deps.store.get(runAt);
    if (stored) return stored;

    const nowSeconds = Math.floor(this.deps.nowMs() / 1000);
    const lead = this.deps.maxLeadSeconds ?? RUN_INTERVAL_SECONDS;
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
    const snapshot = await buildSnapshot(configuration, eligible, runAt, Math.floor(nowMs / 1000), this.deps.readAccount);
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

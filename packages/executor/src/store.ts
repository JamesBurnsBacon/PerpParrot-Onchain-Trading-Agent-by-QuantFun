// Shared executor storage contract. MemoryStore is for local/tests; PostgresStore
// supplies durable production run claims, controls, run history and action journal.
import type { OrderResult } from "./exchange";
import type { Plan, PlannedOrder } from "./planner";
import type { Hex } from "viem";
import type { TargetRow } from "./target-rows";

export type Controls = { paused: boolean; updatedAt: number; updatedBy: string };

export type RunRecord = {
  // "mirror-<runAt>" for a scheduled run, "flatten-<ms>" for a manual flatten.
  id: string;
  runId: string;
  kind: "mirror" | "flatten";
  status: "executed" | "skipped_paused" | "failed";
  dryRun: boolean;
  startedAt: number;
  finishedAt: number;
  equityUsd?: number;
  plan?: Plan;
  results?: OrderResult[];
  error?: string;
  // What the run traded toward: the backend snapshot hash, configuration and target exposures.
  evidence?: unknown;
};

export type RunSummary = Omit<RunRecord, "plan" | "results" | "evidence"> & { orders: number };
export const summarize = ({ plan, results: _results, evidence: _evidence, ...run }: RunRecord): RunSummary => ({ ...run, orders: plan?.orders.length ?? 0 });
export const runAtMs = (run: Pick<RunRecord, "runId" | "startedAt">): number => {
  const m = /-(\d+)$/.exec(run.runId);
  return m ? Number(m[1]) * 1000 : run.startedAt;
};
export type EquityPoint = { t: number; equityUsd: number; dryRun: boolean };

export type OrderBatch = {
  id: string;
  runId: string;
  createdAt: number;
  orders: PlannedOrder[];
  cloids: Hex[];
  kind: "orders" | "leverage";
  details?: { asset: string; assetId: number; leverage: number };
  state: "dispatching" | "settled" | "uncertain" | "reconciled";
  results?: OrderResult[];
  resolution?: { by: string; evidence: string; at: number };
};

export interface ExecutorStore {
  beginOrderBatch(batch: Omit<OrderBatch, "state" | "results" | "resolution">): Promise<void>;
  finishOrderBatch(id: string, results: OrderResult[]): Promise<void>;
  unresolvedOrderBatches(): Promise<OrderBatch[]>;
  reconcileOrderBatch(id: string, by: string, evidence: string, at: number): Promise<void>;
  // Atomically claims a run (one per 10-minute slot); false if another trigger already did.
  claimRun(runId: string): Promise<boolean>;
  saveRun(run: RunRecord): Promise<void>;
  // Target history (run_targets): one row per perp per run; saving a run's rows again is a no-op.
  saveTargets(rows: TargetRow[]): Promise<void>;
  recentTargets(limit: number): Promise<TargetRow[]>;
  recentRuns(limit: number): Promise<RunRecord[]>;
  recentRunSummaries(limit: number): Promise<RunSummary[]>;
  equityCurve(): Promise<EquityPoint[]>;
  getControls(): Promise<Controls>;
  setControls(controls: Controls): Promise<void>;
}

export class MemoryStore implements ExecutorStore {
  private readonly claimed = new Set<string>();
  private readonly runs: RunRecord[] = [];
  private readonly batches = new Map<string, OrderBatch>();
  private readonly targets: TargetRow[] = [];
  private controls: Controls = { paused: false, updatedAt: 0, updatedBy: "default" };

  private executionLock: Promise<void> = Promise.resolve();

  async beginOrderBatch(batch: Omit<OrderBatch, "state" | "results" | "resolution">) {
    if (this.batches.has(batch.id)) throw new Error("order batch already journaled");
    this.batches.set(batch.id, { ...batch, state: "dispatching" });
  }

  async finishOrderBatch(id: string, results: OrderResult[]) {
    const batch = this.batches.get(id);
    if (!batch || batch.state !== "dispatching") throw new Error("order batch is not dispatching");
    batch.results = structuredClone(results);
    batch.state = results.some((r) => r.status === "unknown") ? "uncertain" : "settled";
  }

  async unresolvedOrderBatches() {
    return structuredClone([...this.batches.values()].filter((b) => b.state === "dispatching" || b.state === "uncertain"));
  }

  async reconcileOrderBatch(id: string, by: string, evidence: string, at: number) {
    const batch = this.batches.get(id);
    if (!batch || (batch.state !== "dispatching" && batch.state !== "uncertain")) throw new Error("order batch is not unresolved");
    batch.state = "reconciled";
    batch.resolution = { by, evidence, at };
  }

  async claimRun(runId: string) {
    if (this.claimed.has(runId)) return false;
    this.claimed.add(runId);
    return true;
  }

  async saveRun(run: RunRecord) {
    this.runs.push(run);
    if (this.runs.length > 1000) this.runs.shift();
  }

  async saveTargets(rows: TargetRow[]) {
    const saved = new Set(this.targets.map((r) => `${r.runId}:${r.asset}`));
    this.targets.push(...structuredClone(rows.filter((r) => !saved.has(`${r.runId}:${r.asset}`))));
    if (this.targets.length > 20_000) this.targets.splice(0, this.targets.length - 20_000);
  }

  async recentTargets(limit: number) {
    return structuredClone([...this.targets].sort((a, b) => b.runAt - a.runAt || (a.asset < b.asset ? -1 : 1)).slice(0, limit));
  }

  async recentRuns(limit: number) {
    return this.runs.slice(-limit).reverse();
  }

  async recentRunSummaries(limit: number) { return (await this.recentRuns(limit)).map(summarize); }

  async equityCurve() {
    return this.runs.filter((r) => r.kind === "mirror" && r.status === "executed" && r.equityUsd !== undefined)
      .map((r): EquityPoint => ({ t: runAtMs(r), equityUsd: r.equityUsd!, dryRun: r.dryRun })).sort((a, b) => a.t - b.t);
  }

  async getControls() {
    return this.controls;
  }

  async setControls(controls: Controls) {
    this.controls = controls;
  }
}

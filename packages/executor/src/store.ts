// Shared executor storage contract. MemoryStore is for local/tests; PostgresStore
// supplies durable production report claims, controls, run history and action journal.
import type { OrderResult } from "./exchange";
import type { Plan, PlannedOrder } from "./planner";
import type { Hex } from "viem";

export type Controls = { paused: boolean; updatedAt: number; updatedBy: string };

export type RunRecord = {
  // Report ID (keccak256 of the raw report), or "flatten-<ms>" for a manual flatten.
  id: string;
  runId: string;
  kind: "report" | "flatten";
  status: "executed" | "skipped_paused" | "failed";
  dryRun: boolean;
  startedAt: number;
  finishedAt: number;
  equityUsd?: number;
  plan?: Plan;
  results?: OrderResult[];
  error?: string;
  // The raw signed report, kept so anyone can re-verify it (README §4.7).
  envelope?: unknown;
};

export type RunSummary = Omit<RunRecord, "plan" | "results" | "envelope"> & { orders: number };
export const summarize = ({ plan, results: _results, envelope: _envelope, ...run }: RunRecord): RunSummary => ({ ...run, orders: plan?.orders.length ?? 0 });
export const runAtMs = (run: Pick<RunRecord, "runId" | "startedAt">): number => {
  const m = /-(\d+)$/.exec(run.runId);
  return m ? Number(m[1]) * 1000 : run.startedAt;
};
export type EquityPoint = { t: number; equityUsd: number; dryRun: boolean };

export type OrderBatch = {
  id: string;
  reportId: string;
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
  // Atomically records a report ID; false if it was already claimed.
  claimReport(id: string): Promise<boolean>;
  saveRun(run: RunRecord): Promise<void>;
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

  async claimReport(id: string) {
    if (this.claimed.has(id)) return false;
    this.claimed.add(id);
    return true;
  }

  async saveRun(run: RunRecord) {
    this.runs.push(run);
    if (this.runs.length > 1000) this.runs.shift();
  }

  async recentRuns(limit: number) {
    return this.runs.slice(-limit).reverse();
  }

  async recentRunSummaries(limit: number) { return (await this.recentRuns(limit)).map(summarize); }

  async equityCurve() {
    return this.runs.filter((r) => r.kind === "report" && r.status === "executed" && r.equityUsd !== undefined)
      .map((r): EquityPoint => ({ t: runAtMs(r), equityUsd: r.equityUsd!, dryRun: r.dryRun })).sort((a, b) => a.t - b.t);
  }

  async getControls() {
    return this.controls;
  }

  async setControls(controls: Controls) {
    this.controls = controls;
  }
}

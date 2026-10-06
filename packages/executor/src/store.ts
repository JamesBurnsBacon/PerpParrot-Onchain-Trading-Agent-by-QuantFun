// Executor persistence. In memory for now; the Supabase implementation follows the
// same interface once the project is connected (tables in supabase/migrations).
import type { OrderResult } from "./exchange";
import type { Plan } from "./planner";

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

// A run without its plan, results and report: enough for an equity curve or a run strip.
export type RunSummary = Omit<RunRecord, "plan" | "results" | "envelope"> & { orders: number };

export const summarize = ({ plan, results, envelope, ...run }: RunRecord): RunSummary => ({
  ...run,
  orders: plan?.orders.length ?? 0,
});

// Run time of a report run: its runId is "mirror-<runAt>" (unix seconds).
export const runAtMs = (run: Pick<RunRecord, "runId" | "startedAt">): number => {
  const m = /-(\d+)$/.exec(run.runId);
  return m ? Number(m[1]) * 1000 : run.startedAt;
};

export interface ExecutorStore {
  // Atomically records a report ID; false if it was already claimed.
  claimReport(id: string): Promise<boolean>;
  saveRun(run: RunRecord): Promise<void>;
  recentRuns(limit: number): Promise<RunRecord[]>;
  recentRunSummaries(limit: number): Promise<RunSummary[]>;
  // [run time ms, equity] of every executed report run, oldest first.
  equityCurve(): Promise<[number, number][]>;
  getControls(): Promise<Controls>;
  setControls(controls: Controls): Promise<void>;
}

export class MemoryStore implements ExecutorStore {
  private readonly claimed = new Set<string>();
  private readonly runs: RunRecord[] = [];
  private controls: Controls = { paused: false, updatedAt: 0, updatedBy: "default" };

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

  async recentRunSummaries(limit: number) {
    return (await this.recentRuns(limit)).map(summarize);
  }

  async equityCurve() {
    return this.runs
      .filter((r) => r.kind === "report" && r.status === "executed" && r.equityUsd !== undefined)
      .map((r): [number, number] => [runAtMs(r), r.equityUsd!])
      .sort((a, b) => a[0] - b[0]);
  }

  async getControls() {
    return this.controls;
  }

  async setControls(controls: Controls) {
    this.controls = controls;
  }
}

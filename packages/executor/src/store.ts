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

export interface ExecutorStore {
  // Atomically records a report ID; false if it was already claimed.
  claimReport(id: string): Promise<boolean>;
  saveRun(run: RunRecord): Promise<void>;
  recentRuns(limit: number): Promise<RunRecord[]>;
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

  async getControls() {
    return this.controls;
  }

  async setControls(controls: Controls) {
    this.controls = controls;
  }
}

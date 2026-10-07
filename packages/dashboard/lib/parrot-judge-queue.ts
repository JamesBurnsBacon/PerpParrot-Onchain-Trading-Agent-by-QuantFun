import { isDecision, type Decision } from "../../shared/receipt";
export type ReceiptRow = { id: number; claim: string; facts: string; state: "checking" | "done" | "skipped" | "unavailable"; decision?: Decision; roundTrip?: number };
export type ReceiptFeed = { rows: ReceiptRow[]; calls: number; cost: number; skipped: number; paused: boolean };
export const emptyReceiptFeed = (): ReceiptFeed => ({ rows: [], calls: 0, cost: 0, skipped: 0, paused: false });
export type Judge = (claim: string, facts: string, signal: AbortSignal) => Promise<{ status: number; value?: unknown }>;
export function createJudgeQueue(judge: Judge, changed: (feed: ReceiptFeed, verdict?: ReceiptRow) => void, now = () => performance.now(), pauseOnFailure = false) {
  let feed = emptyReceiptFeed(), serial = 0, stopped = false, last = "";
  let turn = { facts: "", calls: 0 };
  type Job = { row: ReceiptRow; turn: typeof turn };
  const waiting: Job[] = [], active = new Map<Job, AbortController>();
  const publish = (row?: ReceiptRow) => changed({ ...feed, rows: feed.rows.map(r => ({ ...r })) }, row);
  function skip(job: Job) { job.row.state = "skipped"; feed.skipped++; }
  function cancel() {
    for (const job of waiting.splice(0)) skip(job);
    for (const [job, controller] of active) { skip(job); controller.abort(); }
    active.clear();
  }
  function pump() {
    while (!stopped && !feed.paused && active.size < 2 && waiting.length) {
      const job = waiting.shift()!;
      if (job.turn.calls >= 12) { skip(job); publish(); continue; }
      const controller = new AbortController(), start = now(); active.set(job, controller);
      job.turn.calls++; feed.calls++; publish();
      void (async () => judge(job.row.claim, job.row.facts, controller.signal))().then(result => {
        if (controller.signal.aborted || !result) return;
        if (result.status === 503 || result.status === 429) { feed.paused = true; cancel(); publish(); return; }
        if (result.status !== 200 || !isDecision(result.value, { claim: job.row.claim, facts: job.row.facts })) throw new Error("unavailable");
        job.row.decision = result.value; job.row.state = "done"; job.row.roundTrip = now() - start;
        feed.cost += result.value.costUsd; publish(job.row);
      }).catch(() => { if (!controller.signal.aborted) {
        if (pauseOnFailure) { feed.paused = true; cancel(); }
        job.row.state = "unavailable"; publish();
      } })
        .finally(() => { active.delete(job); pump(); });
    }
  }
  return {
    setFacts(facts: string) { turn = { facts, calls: 0 }; last = ""; },
    push(claim: string) {
      if (stopped || claim === last) return;
      last = claim;
      const row: ReceiptRow = { id: ++serial, claim, facts: turn.facts, state: "checking" }, job = { row, turn };
      feed.rows = [row, ...feed.rows].slice(0, 20);
      if (!turn.facts || feed.paused || turn.calls >= 12) skip(job);
      else { if (waiting.length >= 8) skip(waiting.shift()!); waiting.push(job); }
      publish(); pump();
    },
    stop() { stopped = true; cancel(); publish(); },
  };
}

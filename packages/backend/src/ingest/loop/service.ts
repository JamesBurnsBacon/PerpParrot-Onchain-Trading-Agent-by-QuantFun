import { scoreCandidates } from "../../score";
import { LoopStore, type Account, type Run, type Selection, bucketAt, INTERVAL_MS, TARGET_COUNT } from "./store";
import { rankAsync } from "./ranking";
import { SCORE_LABEL } from "./rank";
import type { Collected } from "./collect";
import { digest } from "../store";
import { scoreSourceHash } from "./export-data";

export type Collector = { collect(account: Account, signal: AbortSignal): Promise<Collected>;
  client?: { requests: number; retries: number; rateLimited: number;
    setContext?: (context: { runId: string; slot: number; address: string } | null) => void } };
export class LoopService {
  private active: Promise<unknown> | null = null;
  private stopping = false;
  private controller: AbortController | null = null;
  constructor(readonly store: LoopStore, private collector: Collector,
    private rank: (accounts: Account[], now: number) => Promise<Selection[]> = rankAsync,
    private now: () => number = Date.now) {}

  trigger(bucket = bucketAt(this.now())) {
    if (this.stopping) throw new Error("Worker is stopping");
    if (!this.store.state("bootstrapComplete")) throw new Error("Evidence bootstrap not complete");
    const selection = this.store.state<{ selected: Selection[] }>("selection");
    if (!selection) throw new Error("No strict Score selection");
    return this.store.enqueue(bucket, selection.selected, this.now());
  }
  start(run: Run): Promise<unknown> {
    if (this.active) return this.active;
    if (this.stopping) return Promise.reject(new Error("Worker is stopping"));
    this.active = this.execute(run).finally(() => { this.active = null; });
    return this.active;
  }
  async tick() {
    if (this.stopping || this.active || !this.store.state("bootstrapComplete")) return;
    const latest = this.store.state<{ bucket: number }>("latest");
    const pending = this.store.runs().reverse().find(r => r.status !== "complete" && r.attempts < 3
      && (!latest || r.bucket > latest.bucket) && this.now() - r.bucket <= INTERVAL_MS * 2
      && (!r.finishedAt || this.now() - r.finishedAt >= 60_000));
    const run = pending ?? this.trigger();
    if (run.status === "complete" || run.attempts >= 3) return;
    if (run.finishedAt && this.now() - run.finishedAt < 60_000) return;
    return this.start(run);
  }
  async stop() {
    this.stopping = true; this.controller?.abort(new Error("Worker shutdown; progress saved"));
    await this.active?.catch(() => {});
  }
  async execute(requested: Run) {
    const owner = this.store.claim(this.now());
    if (!owner) return { status: "worker-busy" };
    const controller = new AbortController();
    this.controller = controller;
    const started = this.now(), counters = this.collector.client ? { requests: this.collector.client.requests,
      retries: this.collector.client.retries, rateLimited: this.collector.client.rateLimited } : null;
    const timeout = setTimeout(() => controller.abort(new Error("Cycle exceeded nine-minute deadline")), 540_000);
    const heartbeat = setInterval(() => {
      try { this.store.renew(owner, this.now()); } catch (error) { controller.abort(error); }
    }, 15_000);
    let run = this.store.run(requested.id)!;
    try {
      if (run.status === "complete") return run;
      if (run.attempts >= 3) return { runId: run.id, status: "retry-limit" };
      if (this.now() - run.bucket > INTERVAL_MS * 2) throw new Error("Run too old to resume");
      run = { ...run, status: "running", startedAt: run.startedAt ?? this.now(), attempts: run.attempts + 1, error: null };
      this.store.saveRun(run);
      const saved = this.store.records<Collected>(run.id), collected: Collected[] = [];
      for (const [slot, selection] of run.selected.entries()) {
        controller.signal.throwIfAborted(); this.store.assertOwner(owner, this.now());
        this.collector.client?.setContext?.({ runId: run.id, slot, address: selection.address });
        let result = saved.get(selection.address);
        if (result && (this.now() - Date.parse(result.account.fetchedAt) > 300_000
          || Date.parse(result.account.fetchedAt) > this.now())) result = undefined;
        if (result) this.store.raw(result.account.rawHash);
        else result = await this.collector.collect(this.store.account(selection.address), controller.signal);
        if (result.account.input.address !== selection.address) throw new Error("Collected address mismatch");
        collected.push(result);
        this.store.saveRecord(run.id, selection.address, result, owner, this.now());
        this.store.setState("progress", { runId: run.id, completed: collected.length, total: TARGET_COUNT, updatedAt: this.now() });
      }
      const updates = new Map(collected.map(r => [r.account.input.address, r.account]));
      const registry = this.store.accounts().map(a => updates.get(a.input.address) ?? a);
      const next = await this.rank(registry, this.now());
      controller.signal.throwIfAborted();
      if (next.length !== TARGET_COUNT) throw new Error("Fewer than 100 strict Score accounts remain; retaining last complete publication");
      const accounts = collected.map(r => r.account), strict = scoreCandidates(accounts.map(a => a.input));
      const codeHash = await scoreSourceHash(), completedAt = this.now();
      const oldest = Math.min(...accounts.map(a => Date.parse(a.fetchedAt)));
      if (this.now() - oldest > 540_000) throw new Error("Collection too old to publish");
      const artifact = {
        schema: "ingest-cycle.v1", runId: run.id, bucket: run.bucket, completedAt,
        count: TARGET_COUNT, status: "complete", scoreLabel: SCORE_LABEL, scoreConfig: strict.config,
        selected: run.selected, nextSelection: next,
        // The strict batch score is explicitly scoped to these 100 inputs;
        // nextSelection uses the full registry and the same unchanged Score.
        scoreScope: "current-100-account-batch", registryCount: registry.length,
        provenance: { cohort: this.store.state("seed"), targetListSha256: digest(JSON.stringify(run.selected.map(s => s.address))),
          scoreSourceSha256: codeHash, scoreConfigSha256: digest(JSON.stringify(strict.config)), evaluationCutoff: completedAt,
          success: TARGET_COUNT, failure: 0, notFetched: 0 },
        inputAsOfRange: { oldest: new Date(oldest).toISOString(), newest: accounts.map(a => a.fetchedAt).sort().at(-1) },
        inputs: accounts.map(a => a.input), strict,
        evidence: accounts.map(a => ({ address: a.input.address, fetchedAt: a.fetchedAt, portfolioSha256: a.rawHash,
          classification: a.classification, classificationAt: a.classificationAt, fillsSha256: a.fillsHash, fillsCheckedAt: a.fillsCheckedAt,
          investigation: this.store.state(`investigation:${a.input.address}`) })),
        requestAttempts: this.store.requestAttempts(run.id),
        historyWarnings: collected.flatMap(r => r.historyWarnings.map(warning => ({ address: r.account.input.address, warning }))),
        durationSeconds: (this.now() - started) / 1000,
        upstream: counters && this.collector.client ? { requests: this.collector.client.requests - counters.requests,
          retries: this.collector.client.retries - counters.retries, rateLimited: this.collector.client.rateLimited - counters.rateLimited } : null,
      };
      const hash = this.store.publish(run, accounts, artifact, next, owner, completedAt);
      return { runId: run.id, status: "complete", count: TARGET_COUNT, artifactHash: hash,
        durationSeconds: artifact.durationSeconds, upstream: artifact.upstream, strictEligible: strict.candidates.filter(c => c.eligible).length };
    } catch (error) {
      // A lost owner is fenced from changing either status or published data.
      try {
        this.store.assertOwner(owner, this.now());
        this.store.saveRun({ ...run, status: "failed", finishedAt: this.now(), error: String(error) });
      } catch { /* another worker owns recovery */ }
      throw error;
    } finally { clearInterval(heartbeat); clearTimeout(timeout); this.store.release(owner);
      this.collector.client?.setContext?.(null); if (this.controller === controller) this.controller = null; }
  }
}

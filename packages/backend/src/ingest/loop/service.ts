import { scoreCandidates } from "../../score";
import { LoopStore, type Account, type Run, type Selection, bucketAt, INTERVAL_MS, TARGET_COUNT } from "./store";
import { rankAsync } from "./ranking";
import { SCORE_LABEL } from "./rank";
import type { Collected } from "./collect";
import { digest } from "../store";
import { scoreSourceHash } from "./export-data";
import { availableAccounts, backgroundRefresh } from "./background";
import { requireCollection, isStrictEligible } from "./checks";

const MAX_SUBSTITUTIONS = 20;

export type Collector = { collect(account: Account, signal: AbortSignal): Promise<Collected>;
  client?: { requests: number; retries: number; rateLimited: number;
    setContext?: (context: { runId: string; slot: number; address: string } | null) => void } };
export class LoopService {
  private active: Promise<unknown> | null = null;
  private stopping = false;
  private controller: AbortController | null = null;
  private backgroundActive: Promise<unknown> | null = null;
  private backgroundController: AbortController | null = null;
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
    this.backgroundController?.abort(new Error("Foreground Top 100 takes priority"));
    this.active = (this.backgroundActive ? this.backgroundActive.catch(() => {}).then(() => this.execute(run)) : this.execute(run))
      .finally(() => { this.active = null; });
    return this.active;
  }
  async tick() {
    if (this.stopping || this.active) return;
    const latest = this.store.state<{ bucket: number }>("latest");
    const pending = this.store.runs().reverse().find(r => r.status !== "complete" && r.attempts < 3
      && (!latest || r.bucket > latest.bucket) && this.now() - r.bucket <= INTERVAL_MS * 2
      && (!r.finishedAt || this.now() - r.finishedAt >= 60_000));
    // A failed batch without fresh replacements must let registry repair make
    // progress, even while that batch is pending. The marker survives restart.
    const run = this.store.state("foregroundNeedsRefresh") ? null
      : pending ?? (this.store.state("bootstrapComplete") ? this.trigger() : null);
    if (run && run.status !== "complete" && run.attempts < 3
      && (!run.finishedAt || this.now() - run.finishedAt >= 60_000)) return this.start(run);
    if (this.backgroundActive) return;
    const abort = new AbortController(); this.backgroundController = abort;
    this.backgroundActive = backgroundRefresh(this.store, this.collector, this.now, abort.signal).finally(() => {
      this.backgroundActive = null; if (this.backgroundController === abort) this.backgroundController = null;
    });
    return this.backgroundActive;
  }
  async stop() {
    this.stopping = true; this.controller?.abort(new Error("Worker shutdown; progress saved"));
    this.backgroundController?.abort(new Error("Worker shutdown; refresh progress saved"));
    await Promise.all([this.active?.catch(() => {}), this.backgroundActive?.catch(() => {})]);
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
    const requireCatchup = (reason: string) => this.store.db.transaction(() => {
      this.store.assertOwner(owner, this.now());
      this.store.setState("foregroundNeedsRefresh", { runId: run.id, at: this.now(), reason,
        failedAddresses: [...new Set(run.accountFailures?.map(f => f.address) ?? [])] });
      this.store.setState("bootstrapComplete", null); this.store.setState("selection", null);
    })();
    try {
      if (run.status === "complete") return run;
      if (run.attempts >= 3) return { runId: run.id, status: "retry-limit" };
      if (this.now() - run.bucket > INTERVAL_MS * 2) throw new Error("Run too old to resume");
      this.store.interruptUnfinishedRequests(run.id, owner, this.now());
      run = { ...run, status: "running", startedAt: run.startedAt ?? this.now(), attempts: run.attempts + 1, error: null };
      this.store.saveRun(run);
      const saved = this.store.records<Collected>(run.id), collected: Collected[] = [];
      const effective = [...(run.effectiveSelection ?? run.selected)];
      run = { ...run, effectiveSelection: effective, substitutions: run.substitutions ?? [], accountFailures: run.accountFailures ?? [] };
      for (let slot = 0; slot < effective.length; slot++) {
        for (;;) {
          const selection = effective[slot];
          controller.signal.throwIfAborted(); this.store.assertOwner(owner, this.now());
          this.collector.client?.setContext?.({ runId: run.id, slot, address: selection.address });
          let result = saved.get(selection.address);
          if (result && (this.now() - Date.parse(result.account.fetchedAt) > 300_000
            || Date.parse(result.account.fetchedAt) > this.now())) result = undefined;
          try {
            if (this.store.health(selection.address).quarantinedUntil > this.now()) throw new Error("Account is quarantined after repeated collection failures");
            if (!result) {
              this.store.accountAttempt(selection.address, owner, this.now());
              result = await this.collector.collect(this.store.account(selection.address), controller.signal);
            }
            controller.signal.throwIfAborted(); requireCollection(this.store, result, selection.address, this.now());
            if (!isStrictEligible(result)) throw new Error("Refreshed account fails strict Score eligibility");
            this.store.accountAttempt(selection.address, owner, this.now(), { success: true });
            collected.push(result);
            this.store.saveRecord(run.id, selection.address, result, owner, this.now());
            this.store.setState("progress", { runId: run.id, completed: collected.length, total: TARGET_COUNT, updatedAt: this.now() });
            break;
          } catch (error) {
            controller.signal.throwIfAborted(); this.store.assertOwner(owner, this.now());
            const reason = String(error).slice(0, 240), previous = this.store.health(selection.address);
            const health = previous.quarantinedUntil > this.now() ? previous
              : this.store.accountAttempt(selection.address, owner, this.now(), { error: reason });
            run.accountFailures!.push({ address: selection.address, slot, at: this.now(), reason, consecutiveFailures: health.consecutiveFailures });
            this.store.saveRun(run);
            if (run.substitutions!.length >= MAX_SUBSTITUTIONS) {
              requireCatchup("Bounded replacement limit reached");
              throw new Error("Bounded replacement limit reached; retaining last complete publication");
            }
            const updates = new Map(collected.map(r => [r.account.input.address, r.account]));
            const registry = availableAccounts(this.store, this.store.accounts().map(a => updates.get(a.input.address) ?? a), this.now());
            const ranked = await rankAsync(registry, this.now(), Number.MAX_SAFE_INTEGER, controller.signal);
            const used = new Set([...run.selected.map(s => s.address), ...effective.map(s => s.address), ...run.accountFailures!.map(f => f.address)]);
            const replacement = ranked.find(s => !used.has(s.address));
            if (!replacement) { requireCatchup("No fresh strict replacement available"); throw error; }
            run.substitutions!.push({ slot, from: selection.address, to: replacement.address, at: this.now(), reason,
              rankingSha256: digest(JSON.stringify(ranked)) });
            effective[slot] = replacement;
            this.store.saveRun(run); // Commit substitution before its request; restart uses this exact slot.
          }
        }
      }
      const updates = new Map(collected.map(r => [r.account.input.address, r.account]));
      const registry = this.store.accounts().map(a => updates.get(a.input.address) ?? a);
      const omitted = new Set(run.accountFailures!.map(f => f.address).filter(a => !effective.some(s => s.address === a)));
      const next = await this.rank(availableAccounts(this.store, registry, this.now()).filter(a => !omitted.has(a.input.address)), this.now());
      controller.signal.throwIfAborted();
      if (next.length !== TARGET_COUNT) {
        requireCatchup("Fewer than 100 fresh strict accounts remain");
        throw new Error("Fewer than 100 strict Score accounts remain; retaining last complete publication");
      }
      const accounts = collected.map(r => r.account), strict = scoreCandidates(accounts.map(a => a.input));
      if (strict.candidates.some(c => !c.eligible)) throw new Error("All 100 effective inputs must pass strict Score before publication");
      const codeHash = await scoreSourceHash(), completedAt = this.now();
      const oldest = Math.min(...accounts.map(a => Date.parse(a.fetchedAt)));
      if (this.now() - oldest > 540_000) throw new Error("Collection too old to publish");
      const artifact = {
        schema: "ingest-cycle.v1", runId: run.id, bucket: run.bucket, completedAt,
        count: TARGET_COUNT, status: "complete", scoreLabel: SCORE_LABEL, scoreConfig: strict.config,
        selected: effective, originalSelection: run.selected, effectiveSelection: effective,
        selectionSemantics: "effective-after-recorded-substitutions", substitutions: run.substitutions,
        accountFailures: run.accountFailures, nextSelection: next,
        // The strict batch score is explicitly scoped to these 100 inputs;
        // nextSelection uses the full registry and the same unchanged Score.
        scoreScope: "current-100-account-batch", registryCount: registry.length,
        provenance: { cohort: this.store.state("seed"), targetListSha256: digest(JSON.stringify(effective.map(s => s.address))),
          originalTargetListSha256: digest(JSON.stringify(run.selected.map(s => s.address))),
          scoreSourceSha256: codeHash, scoreConfigSha256: digest(JSON.stringify(strict.config)), evaluationCutoff: completedAt,
          success: TARGET_COUNT, failure: 0, notFetched: 0, failedAccountAttempts: run.accountFailures!.length,
          substitutions: run.substitutions!.length },
        inputAsOfRange: { oldest: new Date(oldest).toISOString(), newest: accounts.map(a => a.fetchedAt).sort().at(-1) },
        inputs: accounts.map(a => a.input), strict,
        evidence: accounts.map(a => ({ address: a.input.address, fetchedAt: a.fetchedAt, portfolioSha256: a.rawHash,
          classification: a.classification, classificationAt: a.classificationAt, fillsSha256: a.fillsHash, fillsCheckedAt: a.fillsCheckedAt,
          investigation: this.store.state(`investigation:${a.input.address}`) })),
        requestAttempts: this.store.requestAttempts(run.id),
        historyWarnings: collected.flatMap(r => r.historyWarnings.map(warning => ({ address: r.account.input.address, warning }))),
        durationSeconds: (this.now() - started) / 1000,
        runElapsedSeconds: (completedAt - (run.startedAt ?? started)) / 1000,
        upstream: counters && this.collector.client ? { requests: this.collector.client.requests - counters.requests,
          retries: this.collector.client.retries - counters.retries, rateLimited: this.collector.client.rateLimited - counters.rateLimited,
          scope: "current-worker-attempt", fullRunRequestAttempts: this.store.requestAttempts(run.id).length } : null,
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

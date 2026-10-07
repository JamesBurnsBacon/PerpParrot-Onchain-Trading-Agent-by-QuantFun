import { keccak256, toHex, type Hex } from "viem";
import type { Alert } from "./alerts";
import type { Exchange } from "./exchange";
import { loadAccount, loadMarkets, type InfoFn } from "./hyperliquid";
import { planFlatten, planOrders, type Market, type Plan, type PlanConfig } from "./planner";
import type { ExecutorStore, RunRecord } from "./store";
import type { TargetSource } from "./targets";
import { noLock, type RunLock } from "./lock";

export type RunnerConfig = {
  account: Hex;
  // The frozen configuration the backend's targets must come from (README §4.7).
  frozenConfigurationHash: string;
  plan: PlanConfig;
  // Sanity bound (README §4.8): reject targets whose gross exposure exceeds this.
  maxGrossLeverage: number;
  // Orders for a run may go out until runAt + this; later, the run is skipped.
  runTtlSeconds: number;
  // A run still going after this is cancelled before its next order batch and alerted on.
  runTimeoutMs: number;
};

export type RunnerDeps = {
  store: ExecutorStore;
  exchange: Exchange;
  info: InfoFn;
  alert: Alert;
  now: () => number;
  config: RunnerConfig;
  // Where a run's targets come from: the backend (targets.ts).
  targets: TargetSource;
  lock?: RunLock;
};

// Stable per-run order identifiers for reconciliation. Do not assume that
// repeating an exchange submission with the same cloid guarantees idempotency.
export const cloidFor = (runId: string, asset: string): Hex => keccak256(toHex(`${runId}:${asset}`)).slice(0, 34) as Hex;

type CancelToken = { cancelled: boolean };

export class Runner {
  // One run at a time: runs are 10 minutes apart, so queueing is enough (README §4.8).
  private queue: Promise<unknown> = Promise.resolve();
  private readonly leverageSet = new Set<number>();
  // When the last scheduled run started (status page).
  lastRunAt = 0;
  // When the last run finished, whatever its outcome (the watchdog uses it).
  lastFinishedAt = 0;

  constructor(private readonly deps: RunnerDeps) {}

  // Runs never overlap, even when one is slow: a run still sending orders while the
  // next one plans against a stale account could double exposure. A run that passes
  // runTimeoutMs is cancelled (it stops before its next leverage update or order
  // batch) and alerted on, but the queue only moves on once it has really finished.
  // Postgres queries time out on their own (pg-store.ts), so a dead database can't
  // hang a run forever.
  private serial(runId: string, fn: (token: CancelToken) => Promise<RunRecord>): Promise<RunRecord> {
    const { runTimeoutMs } = this.deps.config;
    const bounded = async (): Promise<RunRecord> => {
      const token: CancelToken = { cancelled: false };
      const timer = setTimeout(() => {
        token.cancelled = true;
        void this.deps.alert(`${runId}: still running after ${runTimeoutMs / 1000}s; cancelling before its next order batch`).catch(() => undefined);
      }, runTimeoutMs);
      try {
        // Cross-process exclusion is the run lock run() takes (it waits up to runTimeoutMs).
        return await fn(token);
      } catch (e) {
        await this.deps.alert(`${runId}: run could not be completed or recorded: ${(e as Error).message}`).catch(() => undefined);
        throw e;
      } finally {
        clearTimeout(timer);
        this.lastFinishedAt = this.deps.now();
      }
    };
    const next = this.queue.then(bounded, bounded);
    this.queue = next.catch(() => undefined);
    return next;
  }

  // Operator actions that must not interleave with a run (resume, reconciliation): queued behind
  // this process's runs and holding the same cross-process run lock a run takes. Throws when
  // another process holds it for longer than runTimeoutMs.
  exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const task = async (): Promise<T> => {
      const release = await (this.deps.lock ?? noLock).acquire(this.deps.config.runTimeoutMs);
      try {
        return await fn();
      } finally {
        await release().catch(() => undefined);
      }
    };
    const next = this.queue.then(task, task);
    this.queue = next.catch(() => undefined);
    return next;
  }

  // One scheduled run (README §4.7): the backend's targets for runAt, checked against our pinned
  // configuration and account, sized with our live equity, then traded. Any failure, the backend
  // included, is a recorded failed run; the next run tries again.
  executeRun(runAt: number): Promise<RunRecord> {
    this.lastRunAt = this.deps.now();
    const runId = `mirror-${runAt}`;
    const expiresAt = (runAt + this.deps.config.runTtlSeconds) * 1000;
    return this.serial(runId, (token) => this.run(runId, runId, "mirror", undefined, token, async (markets, account, record) => {
      // Re-checked here: the run may have waited in the queue.
      if (this.deps.now() > expiresAt) throw new Error("run expired before execution");
      const targets = await this.deps.targets(runAt);
      record.evidence = { snapshotHash: targets.snapshotHash, configurationHash: targets.configurationHash, exposures: targets.exposures };
      const { config } = this.deps;
      if (targets.configurationHash !== config.frozenConfigurationHash.toLowerCase()) throw new Error(`configuration mismatch: targets from ${targets.configurationHash}`);
      if (targets.account !== config.account.toLowerCase()) throw new Error(`account mismatch: targets for ${targets.account}`);
      const exposures = targets.exposures.map((e) => ({ asset: e.asset, fraction: Number(e.exposureE9) / 1e9 }));
      const gross = exposures.reduce((sum, e) => sum + Math.abs(e.fraction), 0);
      if (gross > config.maxGrossLeverage) throw new Error(`gross exposure ${gross.toFixed(2)}× exceeds ${config.maxGrossLeverage}×`);
      // Targets = exposure × our equity now (account = truth).
      const equity = Math.max(account.equityUsd, 0);
      return planOrders(new Map(exposures.map((e) => [e.asset, e.fraction * equity])), account, markets, config.plan);
    }, expiresAt));
  }

  // Kill switch: close everything, whatever the targets say (README §4.8).
  flatten(by: string): Promise<RunRecord> {
    const id = `flatten-${this.deps.now()}`;
    return this.serial(id, (token) =>
      this.run(id, id, "flatten", { by }, token, async (markets, account) => planFlatten(account, markets, this.deps.config.plan.slippageBps)),
    );
  }

  private async run(
    id: string,
    runId: string,
    kind: RunRecord["kind"],
    evidence: unknown,
    token: CancelToken,
    makePlan: (markets: Map<string, Market>, account: Awaited<ReturnType<typeof loadAccount>>, record: RunRecord) => Promise<Plan>,
    expiresAt?: number,
  ): Promise<RunRecord> {
    const { store, exchange, info, alert, now, config } = this.deps;
    const record: RunRecord = { id, runId, kind, status: "executed", dryRun: exchange.dryRun, startedAt: now(), finishedAt: 0, evidence };
    let release: (() => Promise<void>) | undefined;
    try {
      release = await (this.deps.lock ?? noLock).acquire(config.runTimeoutMs);
      const unresolved = await store.unresolvedOrderBatches();
      if (kind === "mirror" && unresolved.length > 0) {
        await store.setControls({ paused: true, updatedAt: now(), updatedBy: `unresolved-order-batch:${unresolved[0].id}` });
        record.status = "skipped_paused";
        record.error = `${unresolved.length} order batch(es) need reconciliation`;
        await alert(`${runId}: execution held; reconcile order batch ${unresolved[0].id}`);
        return record;
      }
      const controls = await store.getControls();
      if (kind === "mirror" && controls.paused) {
        record.status = "skipped_paused";
        return record;
      }
      const [markets, account] = await Promise.all([loadMarkets(info), loadAccount(info, config.account)]);
      record.equityUsd = account.equityUsd;
      const plan = await makePlan(markets, account, record);
      record.plan = plan;

      // Re-read durable controls after asynchronous work and before each exchange
      // action. A pause or expiry while loading accounts/updating leverage must
      // prevent subsequent orders, including later batches.
      const stopReason = async (): Promise<string | undefined> => {
        if (token.cancelled) return `run timed out after ${config.runTimeoutMs / 1000}s`;
        if (kind === "mirror" && (await store.getControls()).paused) return "execution paused";
        // Check time after the database read as it can itself be slow.
        if (token.cancelled) return `run timed out after ${config.runTimeoutMs / 1000}s`;
        if (expiresAt !== undefined && now() > expiresAt) return "run expired before exchange action";
        return undefined;
      };
      const assertActive = async (): Promise<void> => {
        const reason = await stopReason();
        if (reason) throw new Error(reason);
      };

      // Journal account leverage changes before dispatch; ambiguous results block
      // every later exchange action until an operator checks account state. A definitive
      // HL refusal skips only that asset's order, as before (README §4.8).
      const failedLeverage = new Set<string>();
      for (const o of plan.orders) {
        await assertActive();
        if (o.reduceOnly || this.leverageSet.has(o.assetId)) continue;
        const leverage = markets.get(o.asset)!.maxLeverage;
        const journalId = `${id}:leverage:${o.assetId}`;
        await store.beginOrderBatch({
          id: journalId, runId: id, createdAt: now(), orders: [], cloids: [], kind: "leverage",
          details: { asset: o.asset, assetId: o.assetId, leverage },
        });
        // Persist intent before dispatch. If the request or process fails before a
        // durable result, startup reconciliation must treat the leverage state as unknown.
        const outcome = await exchange.setLeverage(o.assetId, leverage, expiresAt);
        await store.finishOrderBatch(journalId, []);
        if (outcome.rejected !== undefined) {
          failedLeverage.add(o.asset);
          await alert(`${runId}: leverage update refused for ${o.asset}: ${outcome.rejected}`);
          continue;
        }
        this.leverageSet.add(o.assetId);
      }
      if (failedLeverage.size > 0) {
        plan.skipped.push(
          ...plan.orders
            .filter((o) => failedLeverage.has(o.asset))
            .map((o) => ({ asset: o.asset, reason: "LEVERAGE_FAILED" as const, targetUsd: o.targetUsd, currentUsd: o.currentUsd })),
        );
        plan.orders = plan.orders.filter((o) => !failedLeverage.has(o.asset));
      }
      await assertActive();
      record.results = await exchange.submit(
        plan.orders,
        plan.orders.map((o) => cloidFor(id, o.asset)),
        async () => {
          try {
            const reason = await stopReason();
            if (reason) record.error = reason;
            return reason !== undefined;
          } catch (e) {
            // Preserve already returned fills if the control store fails between
            // batches; remaining orders are explicitly recorded as not sent.
            record.error = `execution guard failed: ${(e as Error).message}`;
            return true;
          }
        },
        expiresAt,
        {
          beforeDispatch: (batchIndex, orders, cloids) => store.beginOrderBatch({
            id: `${id}:${batchIndex}`,
            runId: id,
            createdAt: now(),
            orders: structuredClone(orders),
            cloids: [...cloids],
            kind: "orders",
          }),
          afterResponse: (batchIndex, results) => store.finishOrderBatch(`${id}:${batchIndex}`, results),
        },
      );
      if (record.results.some((r) => r.status === "unknown")) {
        record.status = "failed";
        record.error = "exchange outcome unknown; reconcile order IDs and account before resuming";
        await store.setControls({ paused: true, updatedAt: now(), updatedBy: `unknown-outcome:${id}` });
      }
      if (record.results.some((r) => r.status === "not_sent")) record.status = "failed";
      // Don't overwrite a more important error (e.g. an unknown exchange outcome).
      if (token.cancelled && !record.error) record.error = `run timed out after ${config.runTimeoutMs / 1000}s; later batches not sent`;
      if (record.status === "failed") await alert(`${runId}: stopped remaining orders: ${record.error}`);
      const errors = record.results.filter((r) => r.status === "error");
      if (errors.length > 0) {
        record.status = "failed";
        record.error ??= `${errors.length} order(s) failed: ${errors[0].error}`;
        await alert(`${runId}: ${errors.length} order(s) failed: ${errors[0].error}`);
      }
    } catch (e) {
      record.status = "failed";
      record.error = (e as Error).message;
      await alert(`${runId} failed: ${record.error}`);
    } finally {
      record.finishedAt = now();
      try {
        await store.saveRun(record);
      } finally {
        // A failed unlock must not hide the run (or a saveRun error); Postgres releases the
        // session lock with its connection anyway.
        await release?.().catch((e) => alert(`${runId}: run lock release failed: ${(e as Error).message}`).catch(() => undefined));
      }
    }
    return record;
  }
}

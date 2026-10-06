import { keccak256, toHex, type Hex } from "viem";
import type { Alert } from "./alerts";
import type { Exchange } from "./exchange";
import { loadAccount, loadMarkets, type InfoFn } from "./hyperliquid";
import { planFlatten, planOrders, type Market, type Plan, type PlanConfig } from "./planner";
import { noLock, type RunLock } from "./lock";
import type { ExecutorStore, RunRecord } from "./store";
import type { VerifiedReport } from "./verify";

export type RunnerConfig = {
  account: Hex;
  plan: PlanConfig;
  // Sanity bound (README §4.8): reject reports whose gross exposure exceeds this.
  maxGrossLeverage: number;
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
  // Serializes runs across processes (Postgres advisory lock); none needed for one process.
  lock?: RunLock;
};

// Deterministic per report and asset, so a retried submission can't double-fill.
export const cloidFor = (reportId: string, asset: string): Hex => keccak256(toHex(`${reportId}:${asset}`)).slice(0, 34) as Hex;

type CancelToken = { cancelled: boolean };

export class Runner {
  // One run at a time: reports are 10 minutes apart, so queueing is enough (README §4.8).
  private queue: Promise<unknown> = Promise.resolve();
  private readonly leverageSet = new Set<number>();
  lastReportAt = 0;
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
        return await fn(token);
      } finally {
        clearTimeout(timer);
        this.lastFinishedAt = this.deps.now();
      }
    };
    const next = this.queue.then(bounded, bounded);
    this.queue = next.catch(() => undefined);
    return next;
  }

  executeReport(report: VerifiedReport, envelope: unknown): Promise<RunRecord> {
    this.lastReportAt = this.deps.now();
    const { id, body } = report;
    return this.serial(body.runId, (token) => this.run(id, body.runId, "report", envelope, token, async (markets, account) => {
      // Re-checked here: the report may have waited in the queue.
      if (this.deps.now() > Number(body.expiresAt) * 1000) throw new Error("report expired before execution");
      const exposures = report.body.exposures.map((e) => ({ asset: e.asset, fraction: Number(e.exposureE9) / 1e9 }));
      const gross = exposures.reduce((sum, e) => sum + Math.abs(e.fraction), 0);
      const { maxGrossLeverage } = this.deps.config;
      if (gross > maxGrossLeverage) throw new Error(`gross exposure ${gross.toFixed(2)}× exceeds ${maxGrossLeverage}×`);
      // Targets = DON-attested exposure × our equity now (account = truth).
      const equity = Math.max(account.equityUsd, 0);
      const targets = new Map(exposures.map((e) => [e.asset, e.fraction * equity]));
      return planOrders(targets, account, markets, this.deps.config.plan);
    }));
  }

  // Kill switch: close everything, bypassing CRE (README §4.8).
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
    envelope: unknown,
    token: CancelToken,
    makePlan: (markets: Map<string, Market>, account: Awaited<ReturnType<typeof loadAccount>>) => Promise<Plan>,
  ): Promise<RunRecord> {
    const { store, exchange, info, alert, now, config } = this.deps;
    const record: RunRecord = { id, runId, kind, status: "executed", dryRun: exchange.dryRun, startedAt: now(), finishedAt: 0, envelope };
    let release: (() => Promise<void>) | undefined;
    try {
      // Another process may be mid-run (e.g. during a deploy): wait for it, up to the run timeout.
      release = await (this.deps.lock ?? noLock).acquire(config.runTimeoutMs);
      const controls = await store.getControls();
      if (kind === "report" && controls.paused) {
        record.status = "skipped_paused";
        return record;
      }
      const [markets, account] = await Promise.all([loadMarkets(info), loadAccount(info, config.account)]);
      record.equityUsd = account.equityUsd;
      const plan = await makePlan(markets, account);
      record.plan = plan;

      // Cross margin at each asset's max leverage, set once per asset (README §4.8). If HL
      // refuses for one asset, skip only that asset's order; reductions still go out.
      const failedLeverage = new Set<string>();
      for (const o of plan.orders) {
        if (token.cancelled) throw new Error(`run timed out after ${config.runTimeoutMs / 1000}s`);
        if (o.reduceOnly || this.leverageSet.has(o.assetId)) continue;
        try {
          await exchange.setLeverage(o.assetId, markets.get(o.asset)!.maxLeverage);
          this.leverageSet.add(o.assetId);
        } catch (e) {
          failedLeverage.add(o.asset);
          await alert(`${runId}: leverage update failed for ${o.asset}: ${(e as Error).message}`);
        }
      }
      if (failedLeverage.size > 0) {
        plan.skipped.push(
          ...plan.orders
            .filter((o) => failedLeverage.has(o.asset))
            .map((o) => ({ asset: o.asset, reason: "LEVERAGE_FAILED" as const, targetUsd: o.targetUsd, currentUsd: o.currentUsd })),
        );
        plan.orders = plan.orders.filter((o) => !failedLeverage.has(o.asset));
      }
      if (token.cancelled) throw new Error(`run timed out after ${config.runTimeoutMs / 1000}s`);
      record.results = await exchange.submit(
        plan.orders,
        plan.orders.map((o) => cloidFor(id, o.asset)),
        () => token.cancelled,
      );
      if (token.cancelled) record.error = `run timed out after ${config.runTimeoutMs / 1000}s; later batches not sent`;
      const errors = record.results.filter((r) => r.status === "error");
      if (errors.length > 0) await alert(`${runId}: ${errors.length} order(s) failed: ${errors[0].error}`);
    } catch (e) {
      record.status = "failed";
      record.error = (e as Error).message;
      await alert(`${runId} failed: ${record.error}`);
    } finally {
      record.finishedAt = now();
      try {
        await store.saveRun(record);
      } finally {
        await release?.().catch(() => undefined);
      }
    }
    return record;
  }
}

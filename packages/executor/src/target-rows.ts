// Target history (table run_targets): one row per perp per run that planned. What we aimed for,
// what we held, and the order sent or why none was. Pure, so the mapping is unit-tested; the
// runner saves the rows after the run itself (store.saveTargets).
import type { OrderResult } from "./exchange";
import type { LiveAccount, Market, Plan, SkippedLeg } from "./planner";
import type { RunRecord } from "./store";

export type TargetRow = {
  // The run (executor_runs.id): mirror-<runAt> or flatten-<ms>.
  runId: string;
  // The run's clock in ms: the :x0 slot for a mirror run, the start for a flatten.
  runAt: number;
  asset: string;
  kind: RunRecord["kind"];
  dryRun: boolean;
  runStatus: RunRecord["status"];
  configurationHash: string | null;
  snapshotHash: string | null;
  // The equity the plan was sized with (DRY_RUN_EQUITY_USD in a dry run, when set).
  sizingEquityUsd: number;
  // The backend's signed target as a fraction of equity (0 when the perp isn't targeted).
  targetExposure: number;
  // The pro-rata margin scale the plan applied to every target (1 = none).
  marginScale: number;
  // The target in USD after the margin scale and the tradability cap: what the planner traded toward.
  targetUsd: number;
  heldSize: number;
  markPx: number | null;
  heldUsd: number;
  gapUsd: number;
  // order: an order was planned. skipped: a gap the planner left (skipReason). none: no gap.
  action: "order" | "skipped" | "none";
  // Why there was no order, or NOT_TRADABLE when an order was capped to a reduction.
  skipReason: SkippedLeg["reason"] | null;
  side: "buy" | "sell" | null;
  size: string | null;
  price: string | null;
  reduceOnly: boolean | null;
  notionalUsd: number | null;
  cloid: string | null;
  resultStatus: OrderResult["status"] | null;
  filledSize: string | null;
  avgPx: string | null;
  resultError: string | null;
};

export type TargetRowsInput = {
  record: RunRecord;
  runAt: number;
  plan: Plan;
  markets: Map<string, Market>;
  account: LiveAccount;
  sizingEquityUsd: number;
  // The backend's targets as fractions of equity (empty for a flatten).
  exposures: Map<string, number>;
  configurationHash: string | null;
  snapshotHash: string | null;
  cloidFor: (asset: string) => string;
};

export const targetRows = (input: TargetRowsInput): TargetRow[] => {
  const { record, plan, markets, account, exposures } = input;
  const orders = new Map(plan.orders.map((o, i) => [o.asset, { order: o, result: record.results?.[i] }]));
  const skipped = new Map<string, SkippedLeg>();
  const notTradable = new Set<string>();
  for (const s of plan.skipped) {
    // NOT_TRADABLE notes a capped target; the leg may still trade (a reduction) or be skipped again below.
    if (s.reason === "NOT_TRADABLE") notTradable.add(s.asset);
    else skipped.set(s.asset, s);
  }
  const assets = [...new Set([...exposures.keys(), ...account.positions.keys(), ...orders.keys(), ...skipped.keys(), ...notTradable])].sort();

  return assets.map((asset): TargetRow => {
    const market = markets.get(asset);
    const heldSize = account.positions.get(asset)?.szi ?? 0;
    const markPx = market?.markPx ?? null;
    const heldUsd = markPx === null ? 0 : heldSize * markPx;
    const planned = orders.get(asset);
    const skip = skipped.get(asset);
    // With no order and no skipped gap the planner found no gap: the effective target is what we hold.
    const targetUsd = planned?.order.targetUsd ?? skip?.targetUsd ?? heldUsd;
    const result = planned?.result;
    // Results line up with plan.orders; a run that stopped before submitting sent nothing.
    const resultStatus = planned ? (result?.asset === asset ? result.status : "not_sent") : null;
    return {
      runId: record.id,
      runAt: input.runAt,
      asset,
      kind: record.kind,
      dryRun: record.dryRun,
      runStatus: record.status,
      configurationHash: input.configurationHash,
      snapshotHash: input.snapshotHash,
      sizingEquityUsd: input.sizingEquityUsd,
      targetExposure: exposures.get(asset) ?? 0,
      marginScale: plan.marginScale,
      targetUsd,
      heldSize,
      markPx,
      heldUsd,
      gapUsd: targetUsd - heldUsd,
      action: planned ? "order" : skip || notTradable.has(asset) ? "skipped" : "none",
      skipReason: skip?.reason ?? (notTradable.has(asset) ? "NOT_TRADABLE" : null),
      side: planned ? (planned.order.isBuy ? "buy" : "sell") : null,
      size: planned?.order.size ?? null,
      price: planned?.order.price ?? null,
      reduceOnly: planned?.order.reduceOnly ?? null,
      notionalUsd: planned?.order.notionalUsd ?? null,
      cloid: planned ? input.cloidFor(asset) : null,
      resultStatus,
      filledSize: result?.asset === asset ? (result.filledSize ?? null) : null,
      avgPx: result?.asset === asset ? (result.avgPx ?? null) : null,
      resultError: result?.asset === asset ? (result.error ?? null) : null,
    };
  });
};

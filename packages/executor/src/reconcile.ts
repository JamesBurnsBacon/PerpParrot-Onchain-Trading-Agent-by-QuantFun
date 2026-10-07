// Automatic reconciliation of journaled exchange actions whose outcome we never recorded (a lost
// response, a crash between dispatch and the journal write). No bot ever pauses trading for them:
// only a human freezes or flattens.
//
// Why this is safe: every order and leverage action is signed with expiresAfter (the run's expiry,
// at most runTtlSeconds after the batch was journaled), and Hyperliquid rejects an action after it.
// Once that has passed, the action has either been applied or never will be, so the live account
// is the whole truth and the next plan trades against it. The batch is then closed with
// Hyperliquid's own order status per client order ID as evidence. Before that, a batch is closed
// only if Hyperliquid already shows every order in a final state; otherwise its perps are left
// alone for this run (the rest trade) and it is looked at again on the next.
import type { InfoFn } from "./hyperliquid";
import type { ExecutorStore, OrderBatch } from "./store";

// Clock skew between us and Hyperliquid.
const SKEW_MS = 5_000;

// orderStatus: https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/info-endpoint
type OrderStatusResponse =
  | { status: "order"; order: { order: { origSz: string; sz: string }; status: string } }
  | { status: "unknownOid" };
type ActiveAssetData = { leverage?: { type?: string; value?: number } };

// Order states that can't change any more. IOC orders never rest, so "open" only means not yet final.
const FINAL = /^(filled|canceled|rejected|.*Canceled|.*Rejected)$/;

export type ReconcileOutcome = {
  // Batches closed this time, with the evidence recorded.
  resolved: { id: string; evidence: string }[];
  // Perps of batches that might still land: the run leaves them untouched.
  inFlight: Set<string>;
  // Leverage actions closed: the runner forgets them, so the next opening order sets leverage again.
  leverageAssetIds: number[];
};

export type ReconcileDeps = {
  store: ExecutorStore;
  info: InfoFn;
  account: string;
  now: () => number;
  runTtlSeconds: number;
};

const describeOrder = async (info: InfoFn, user: string, asset: string, cloid: string): Promise<{ text: string; final: boolean }> => {
  try {
    const r = await info<OrderStatusResponse>({ type: "orderStatus", user, oid: cloid });
    if (r.status === "unknownOid") return { text: `${asset} ${cloid}: not on Hyperliquid`, final: false };
    const filled = Number(r.order.order.origSz) - Number(r.order.order.sz);
    return { text: `${asset} ${cloid}: ${r.order.status}, filled ${Number.isFinite(filled) ? filled : "?"} of ${r.order.order.origSz}`, final: FINAL.test(r.order.status) };
  } catch (e) {
    return { text: `${asset} ${cloid}: lookup failed (${(e as Error).message})`, final: false };
  }
};

const describeLeverage = async (info: InfoFn, user: string, details: NonNullable<OrderBatch["details"]>): Promise<{ text: string; final: boolean }> => {
  try {
    const r = await info<ActiveAssetData>({ type: "activeAssetData", user, coin: details.asset });
    const value = r.leverage?.value;
    return { text: `${details.asset} leverage ${r.leverage?.type ?? "?"} ${value ?? "?"}x (wanted cross ${details.leverage}x)`, final: value === details.leverage && r.leverage?.type === "cross" };
  } catch (e) {
    return { text: `${details.asset} leverage lookup failed (${(e as Error).message})`, final: false };
  }
};

export const reconcileBatches = async (deps: ReconcileDeps, batches: OrderBatch[]): Promise<ReconcileOutcome> => {
  const outcome: ReconcileOutcome = { resolved: [], inFlight: new Set(), leverageAssetIds: [] };
  for (const batch of batches) {
    const expired = deps.now() > batch.createdAt + deps.runTtlSeconds * 1000 + SKEW_MS;
    const lookups = batch.kind === "leverage"
      ? [await describeLeverage(deps.info, deps.account, batch.details!)]
      : await Promise.all(batch.orders.map((o, i) => describeOrder(deps.info, deps.account, o.asset, batch.cloids[i])));
    const assets = batch.kind === "leverage" ? [batch.details!.asset] : batch.orders.map((o) => o.asset);
    if (!expired && !lookups.every((l) => l.final)) {
      for (const asset of assets) outcome.inFlight.add(asset);
      continue;
    }
    const evidence = `${expired ? "past its signed expiry, so it can no longer land" : "every order final on Hyperliquid"}; ${lookups.map((l) => l.text).join("; ")}`.slice(0, 2_000);
    await deps.store.reconcileOrderBatch(batch.id, "auto-reconciler", evidence, deps.now());
    outcome.resolved.push({ id: batch.id, evidence });
    if (batch.kind === "leverage") outcome.leverageAssetIds.push(batch.details!.assetId);
  }
  return outcome;
};

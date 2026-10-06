// Order submission through @nktkas/hyperliquid, so actions are built, canonicalized
// and signed exactly as the SDK would send them. In dry-run the transport records
// the signed request instead of POSTing it.
import { HttpTransport } from "@nktkas/hyperliquid";
import { ApiRequestError, order, updateLeverage } from "@nktkas/hyperliquid/api/exchange";
import type { IRequestTransport } from "@nktkas/hyperliquid";
import type { Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import type { PlannedOrder } from "./planner";

export type SignedRequest = { endpoint: string; payload: unknown };

// Records signed exchange requests and answers like HL would for a resting-free IOC
// batch, so the SDK's response checks pass. Never touches the network.
export class DryRunTransport implements IRequestTransport {
  readonly isTestnet = false;
  readonly requests: SignedRequest[] = [];

  async request<T>(endpoint: string, payload: unknown): Promise<T> {
    this.requests.push({ endpoint, payload });
    const action = (payload as { action?: { type?: string; orders?: unknown[] } }).action;
    if (action?.type === "order") {
      // "resting" placeholders: an error status would make the SDK throw.
      return {
        status: "ok",
        response: { type: "order", data: { statuses: (action.orders ?? []).map((_, i) => ({ resting: { oid: i } })) } },
      } as T;
    }
    return { status: "ok", response: { type: "default" } } as T;
  }
}

export type OrderResult = {
  asset: string;
  status: "filled" | "resting" | "error" | "dry_run";
  filledSize?: string;
  avgPx?: string;
  error?: string;
};

export type Exchange = {
  dryRun: boolean;
  signer: Hex;
  submit(orders: PlannedOrder[], cloids: Hex[]): Promise<OrderResult[]>;
  setLeverage(assetId: number, leverage: number): Promise<void>;
  // Signed requests captured in dry-run (for logs and tests).
  recorded(): SignedRequest[];
};

type Status = { filled: { totalSz: string; avgPx: string } } | { resting: unknown } | { error: string };

// Orders per HL action. Keeps each signed request small; reductions go first (planner order).
export const ORDER_BATCH_SIZE = 20;

// Per-order statuses from a response, including one the SDK rejected because some
// orders in the batch errored (ApiRequestError keeps the raw response).
const statusesOf = (response: unknown): Status[] | undefined => {
  const statuses = (response as { response?: { data?: { statuses?: unknown } } })?.response?.data?.statuses;
  return Array.isArray(statuses) ? (statuses as Status[]) : undefined;
};

const toResult = (asset: string, s: Status | undefined, fallbackError: string): OrderResult => {
  if (!s) return { asset, status: "error", error: fallbackError };
  if ("filled" in s) return { asset, status: "filled", filledSize: s.filled.totalSz, avgPx: s.filled.avgPx };
  if ("error" in s) return { asset, status: "error", error: s.error };
  return { asset, status: "resting" };
};

export const createExchange = (opts: { privateKey?: Hex; dryRun: boolean; transport?: IRequestTransport }): Exchange => {
  if (!opts.dryRun && !opts.privateKey) throw new Error("HL_API_WALLET_KEY is required when DRY_RUN=false");
  // In dry-run without a key, sign with a throwaway key so signing is still exercised.
  const wallet = privateKeyToAccount(opts.privateKey ?? (`0x${"11".repeat(32)}` as Hex));
  const dryTransport = new DryRunTransport();
  const transport: IRequestTransport = opts.dryRun ? dryTransport : (opts.transport ?? new HttpTransport());
  const config = { transport, wallet };

  return {
    dryRun: opts.dryRun,
    signer: wallet.address,
    recorded: () => dryTransport.requests,

    async submit(orders, cloids) {
      const results: OrderResult[] = [];
      for (let i = 0; i < orders.length; i += ORDER_BATCH_SIZE) {
        const batch = orders.slice(i, i + ORDER_BATCH_SIZE);
        const params = {
          orders: batch.map((o, j) => ({
            a: o.assetId,
            b: o.isBuy,
            p: o.price,
            s: o.size,
            r: o.reduceOnly,
            t: { limit: { tif: "Ioc" as const } },
            c: cloids[i + j],
          })),
          grouping: "na" as const,
        };
        let statuses: Status[] | undefined;
        let failure = "no status returned";
        try {
          statuses = statusesOf(await order(config, params));
        } catch (e) {
          failure = (e as Error).message;
          statuses = e instanceof ApiRequestError ? statusesOf(e.response) : undefined;
        }
        results.push(
          ...batch.map((o, j) => (opts.dryRun ? { asset: o.asset, status: "dry_run" as const } : toResult(o.asset, statuses?.[j], failure))),
        );
      }
      return results;
    },

    async setLeverage(assetId, leverage) {
      await updateLeverage(config, { asset: assetId, isCross: true, leverage });
    },
  };
};

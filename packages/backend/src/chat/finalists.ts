import { resolve } from "node:path";
import type { FinalistLike } from "../../../shared/strategy-intent";
import { parsePortfolio, scoreCandidates, type ScoreInput } from "../score";
import { mapScoreFinalists } from "../strategy-intent-adapter";

export type DisplayFinalist = FinalistLike & { rank?: number | null; periodReturn?: number | null; sharpe?: number | null };
export type FinalistsData = { finalists: DisplayFinalist[]; dataSource: "live" | "sample" };

export const loadFinalists = async (): Promise<{ finalists: FinalistLike[]; dataSource: "sample" }> => ({
  finalists: await Bun.file(resolve(import.meta.dir, "../../fixtures/sample-finalists.json")).json() as FinalistLike[],
  dataSource: "sample",
});

// One tracked account as the selection pipeline stores it (pipeline_accounts).
export type TrackedAccountRow = {
  address: string;
  kind: "trader" | "hypercore-vault";
  account_value: number;
  closed: boolean | null;
  portfolio: unknown;
  trade_count: number | null;
  maker_share: number | null;
};

// Fewer scored accounts than this is not a meaningful pool: stay on the labelled sample instead.
const MIN_ACCOUNTS = 30;
const MIN_FINALISTS = 5;
const TTL_MS = 5 * 60_000;

/**
 * Finalists for the Parrot: Score run (unchanged) over the accounts the selection pipeline has refreshed.
 * Any shortage or failure falls back to the bundled sample, and `dataSource` says which one the visitor sees.
 * Read-only: it never writes to the pipeline tables and never changes the active configuration.
 */
export function createFinalistsSource(
  queryRows: (() => Promise<TrackedAccountRow[]>) | undefined,
  o: { now?: () => number; log?: (msg: string, data?: Record<string, unknown>) => void; sample?: () => Promise<FinalistsData> } = {},
): () => Promise<FinalistsData> {
  const now = o.now ?? Date.now;
  const log = o.log ?? (() => {});
  const sample = o.sample ?? loadFinalists;
  let cached: { at: number; data: FinalistsData } | undefined;
  let inflight: Promise<FinalistsData> | undefined;
  const compute = async (): Promise<FinalistsData> => {
    if (!queryRows) return sample();
    try {
      const rows = (await queryRows()).filter(r => r.portfolio !== null && r.portfolio !== undefined);
      if (rows.length < MIN_ACCOUNTS) { log("parrot finalists: using sample", { reason: "too few refreshed accounts", accounts: rows.length }); return sample(); }
      const inputs: ScoreInput[] = rows.flatMap(r => {
        try {
          return [{ address: r.address, kind: r.kind, accountValue: r.account_value, closed: r.closed, ...parsePortfolio(r.portfolio),
            history: null, tradeCount: r.trade_count, makerShare: r.maker_share }];
        } catch { return []; } // one malformed stored portfolio must not take the whole pool down
      });
      const result = scoreCandidates(inputs);
      const clones = new Map(result.candidates.map(c => [c.address, c.cloneOf !== null] as const));
      const byAddress = new Map(result.candidates.map(c => [c.address, c]));
      const finalists = mapScoreFinalists(result.candidates, clones).map(f => {
        const c = byAddress.get(f.address)!;
        return { ...f, rank: c.rank, periodReturn: c.metrics?.periodReturn ?? null,
          sharpe: typeof c.metrics?.sharpe === "number" && Number.isFinite(c.metrics.sharpe) ? c.metrics.sharpe : null };
      });
      if (finalists.length < MIN_FINALISTS) { log("parrot finalists: using sample", { reason: "too few finalists", finalists: finalists.length }); return sample(); }
      return { finalists, dataSource: "live" };
    } catch (error) {
      log("parrot finalists: using sample", { reason: "live finalists failed", error: (error as Error).message });
      return sample();
    }
  };
  return async () => {
    if (cached && now() - cached.at < TTL_MS) return cached.data;
    inflight ??= compute().then(data => { cached = { at: now(), data }; return data; }).finally(() => { inflight = undefined; });
    return inflight;
  };
}

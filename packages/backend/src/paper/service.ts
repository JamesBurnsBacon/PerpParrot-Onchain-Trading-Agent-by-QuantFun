import { capGrossExposure, computeExposures, EXPOSURE_SCALE } from "../../../shared/copy";
import type { PositionsSnapshot } from "../../../shared/snapshot";
import { metaAndAssetCtxs } from "../hyperliquid";
import { equityOf, newBook, stepBtcBook, stepCopyBook, type Market, type PaperBook, type PaperConfig } from "./book";

export type PaperPoint = { bookId: string; t: number; equityUsd: number };

export type PaperState = { books: PaperBook[]; lastRunAt: number };

export interface PaperStore {
  load(): Promise<PaperState | undefined>;
  // Saves the books and appends this run's points, atomically where the store can.
  save(state: PaperState, points: PaperPoint[]): Promise<void>;
  points(sinceT: number): Promise<PaperPoint[]>;
}

export class MemoryPaperStore implements PaperStore {
  private state?: PaperState;
  private readonly history: PaperPoint[] = [];
  async load() {
    return this.state && structuredClone(this.state);
  }
  async save(state: PaperState, points: PaperPoint[]) {
    this.state = structuredClone(state);
    this.history.push(...points);
  }
  async points(sinceT: number) {
    return this.history.filter((p) => p.t >= sinceT);
  }
}

export type BookSpec = { id: string; label: string; kind: PaperBook["kind"]; startingEquityUsd: number; multiplier?: number };

// README §4.10. Balanced = Aggressive × m, with m from the backtest (README §4.3 ❓);
// until then PAPER_BALANCED_MULTIPLIER (default 0.5). Conservative and the shadow model
// need their own frozen configurations from the review core.
export const defaultBooks = (balancedMultiplier = 0.5): BookSpec[] => [
  { id: "aggressive-470", label: "Aggressive · $470 (live size)", kind: "copy", startingEquityUsd: 470 },
  { id: "aggressive-10k", label: "Aggressive · $10k twin", kind: "copy", startingEquityUsd: 10_000 },
  { id: "balanced-470", label: `Balanced · $470 (m=${balancedMultiplier})`, kind: "copy", startingEquityUsd: 470, multiplier: balancedMultiplier },
  { id: "btc-hold", label: "BTC buy & hold · $470", kind: "btc", startingEquityUsd: 470 },
];

// Taker fees: 4.5 bps on validator perps (HL base tier). HIP-3 fees depend on the
// deployer's fee scale; 9 bps is an assumption.
const FEE_BPS = { core: 4.5, hip3: 9 };

export const loadPaperMarkets = async (): Promise<Map<string, Market>> => {
  const markets = new Map<string, Market>();
  for (const dex of ["", "xyz"]) {
    const [meta, ctxs] = await metaAndAssetCtxs(dex);
    meta.universe.forEach((u, i) => {
      const markPx = Number(ctxs[i]?.markPx);
      if (!(markPx > 0)) return;
      markets.set(u.name, { markPx, maxLeverage: u.maxLeverage, feeBps: dex ? FEE_BPS.hip3 : FEE_BPS.core });
    });
  }
  return markets;
};

// The same exposures the mirror's DON computes from this snapshot (weights and ceilings
// from the frozen configuration, gross capped at the policy's maxGrossLeverage).
export const exposuresFromSnapshot = (snapshot: PositionsSnapshot): Map<string, number> => {
  const frozen = new Map(snapshot.configuration.sources.map((s) => [s.sourceAddress.toLowerCase(), s]));
  const sources = snapshot.sources.map((s) => ({
    ...s,
    weightE6: frozen.get(s.address)?.weightUnits ?? 0,
    ceilingE6: frozen.get(s.address)?.ceilingUnits ?? 0,
  }));
  const maxGrossE9 = BigInt(Math.round(snapshot.configuration.policy.maxGrossLeverage * Number(EXPOSURE_SCALE)));
  return new Map(
    capGrossExposure(computeExposures(sources), maxGrossE9).map((e) => [e.asset, Number(e.exposureE9) / Number(EXPOSURE_SCALE)]),
  );
};

export class PaperService {
  constructor(
    private readonly deps: {
      store: PaperStore;
      specs: BookSpec[];
      cfg: PaperConfig;
      markets?: () => Promise<Map<string, Market>>;
    },
  ) {}

  // Steps every book once per mirror run; repeated or older runs are ignored.
  async step(runAt: number, snapshotJson: string): Promise<PaperPoint[]> {
    const state = (await this.deps.store.load()) ?? { books: [], lastRunAt: 0 };
    if (runAt <= state.lastRunAt) return [];
    for (const spec of this.deps.specs) {
      if (!state.books.some((b) => b.id === spec.id)) {
        state.books.push(newBook(spec.id, spec.label, spec.kind, spec.startingEquityUsd, runAt, spec.multiplier ?? 1));
      }
    }
    const markets = await (this.deps.markets ?? loadPaperMarkets)();
    const exposures = exposuresFromSnapshot(JSON.parse(snapshotJson) as PositionsSnapshot);
    for (const book of state.books) {
      if (book.kind === "btc") stepBtcBook(book, markets, this.deps.cfg);
      else stepCopyBook(book, exposures, markets, this.deps.cfg);
    }
    const points = state.books.map((b) => ({ bookId: b.id, t: runAt, equityUsd: equityOf(b, markets) }));
    await this.deps.store.save({ ...state, lastRunAt: runAt }, points);
    return points;
  }

  // For the dashboard: each book with its equity curve.
  async view(sinceT = 0) {
    const state = await this.deps.store.load();
    const points = await this.deps.store.points(sinceT);
    return {
      lastRunAt: state?.lastRunAt ?? null,
      books: (state?.books ?? []).map((b) => {
        const curve = points.filter((p) => p.bookId === b.id).map((p) => [p.t, p.equityUsd] as [number, number]);
        const equity = curve.at(-1)?.[1] ?? b.startingEquityUsd;
        return {
          id: b.id,
          label: b.label,
          kind: b.kind,
          startingEquityUsd: b.startingEquityUsd,
          equityUsd: equity,
          returnPct: (equity / b.startingEquityUsd - 1) * 100,
          feesUsd: b.feesUsd,
          trades: b.trades,
          openPositions: Object.keys(b.positions).length,
          curve,
        };
      }),
    };
  }
}

import { EXPOSURE_SCALE, targetsFromSnapshot } from "../../../shared/copy";
import type { PositionsSnapshot } from "../../../shared/snapshot";
import { metaAndAssetCtxs } from "../hyperliquid";
import { accrueFunding, equityOf, newBook, recordMarks, stepBtcBook, stepCopyBook, type Market, type PaperBook, type PaperConfig } from "./book";

export type PaperPoint = { bookId: string; t: number; equityUsd: number };

export type PaperState = { books: PaperBook[]; lastRunAt: number };

export interface PaperStore {
  load(): Promise<PaperState | undefined>;
  // Saves the books and appends this run's points, atomically where the store can. False if
  // a newer or equal run was already saved (another instance stepped it): nothing written.
  save(state: PaperState, points: PaperPoint[]): Promise<boolean>;
  points(sinceT: number): Promise<PaperPoint[]>;
}

export class MemoryPaperStore implements PaperStore {
  private state?: PaperState;
  private readonly history: PaperPoint[] = [];
  async load() {
    return this.state && structuredClone(this.state);
  }
  async save(state: PaperState, points: PaperPoint[]) {
    if (this.state && this.state.lastRunAt >= state.lastRunAt) return false;
    this.state = structuredClone(state);
    this.history.push(...points);
    return true;
  }
  async points(sinceT: number) {
    return this.history.filter((p) => p.t >= sinceT);
  }
}

export type BookSpec = { id: string; label: string; kind: PaperBook["kind"]; startingEquityUsd: number; multiplier?: number };

// README §4.10. Balanced = Aggressive × m, with m from the backtest (README §4.3 ❓);
// until then PAPER_BALANCED_MULTIPLIER (default 0.5). Conservative and the shadow model
// need their own frozen configurations from the review core.
// The buckets differ only by a fixed multiplier on Aggressive's targets (owner, 2026-10-07):
// Aggressive × 1, Balanced × 0.5, Conservative × 0.25. Each at the live size and as a $10k twin.
export const BUCKETS = { aggressive: 1, balanced: 0.5, conservative: 0.25 } as const;

export const defaultBooks = (balancedMultiplier: number = BUCKETS.balanced, conservativeMultiplier: number = BUCKETS.conservative): BookSpec[] => [
  { id: "aggressive-470", label: "Aggressive · $470 (live size)", kind: "copy", startingEquityUsd: 470 },
  { id: "aggressive-10k", label: "Aggressive · $10k twin", kind: "copy", startingEquityUsd: 10_000 },
  { id: "balanced-470", label: `Balanced · $470 (×${balancedMultiplier})`, kind: "copy", startingEquityUsd: 470, multiplier: balancedMultiplier },
  { id: "balanced-10k", label: `Balanced · $10k (×${balancedMultiplier})`, kind: "copy", startingEquityUsd: 10_000, multiplier: balancedMultiplier },
  { id: "conservative-470", label: `Conservative · $470 (×${conservativeMultiplier})`, kind: "copy", startingEquityUsd: 470, multiplier: conservativeMultiplier },
  { id: "conservative-10k", label: `Conservative · $10k (×${conservativeMultiplier})`, kind: "copy", startingEquityUsd: 10_000, multiplier: conservativeMultiplier },
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
      const fundingRate = Number(ctxs[i]?.funding ?? 0);
      markets.set(u.name, {
        markPx,
        maxLeverage: u.maxLeverage,
        feeBps: dex ? FEE_BPS.hip3 : FEE_BPS.core,
        fundingRate: Number.isFinite(fundingRate) ? fundingRate : 0,
      });
    });
  }
  return markets;
};

// The run's target exposures as fractions of equity (shared/copy.ts targetsFromSnapshot): where the
// executor would get no targets, this throws and the books hold, as the executor does.
export const exposuresFromSnapshot = (snapshot: PositionsSnapshot): Map<string, number> =>
  new Map(targetsFromSnapshot(snapshot).map((e) => [e.asset, Number(e.exposureE9) / Number(EXPOSURE_SCALE)]));

// At most `max` points: every point if it fits, else evenly spaced ones plus the last.
const thin = <T,>(points: T[], max: number): T[] => {
  if (points.length <= max) return points;
  const step = (points.length - 1) / (max - 1);
  return Array.from({ length: max }, (_, i) => points[Math.round(i * step)]);
};

const CURVE_POINTS = 1500;

type PaperView = Awaited<ReturnType<PaperService["build"]>>;

export class PaperService {
  // The dashboard's view, rebuilt after each step and at most a minute old (another instance
  // sharing the store may have stepped). `generation` drops a build that raced a step.
  private cached?: { view: PaperView; at: number };
  private generation = 0;

  constructor(
    private readonly deps: {
      store: PaperStore;
      specs: BookSpec[];
      cfg: PaperConfig;
      markets?: () => Promise<Map<string, Market>>;
    },
  ) {}

  // Steps every book once per mirror run; repeated or older runs are ignored.
  // pendingCloses: perps at 0 whose close isn't confirmed yet (shared/copy.ts), kept like the executor keeps them.
  async step(runAt: number, snapshotJson: string, pendingCloses: readonly string[] = []): Promise<PaperPoint[]> {
    const state = (await this.deps.store.load()) ?? { books: [], lastRunAt: 0 };
    if (runAt <= state.lastRunAt) {
      this.invalidate(); // another instance stepped it: our view may predate that
      return [];
    }
    for (const spec of this.deps.specs) {
      if (!state.books.some((b) => b.id === spec.id)) {
        state.books.push(newBook(spec.id, spec.label, spec.kind, spec.startingEquityUsd, runAt, spec.multiplier ?? 1));
      }
    }
    const exposures = exposuresFromSnapshot(JSON.parse(snapshotJson) as PositionsSnapshot);
    const markets = await (this.deps.markets ?? loadPaperMarkets)();
    // Funding for the interval just held; a gap longer than a day counts as a day.
    const hours = state.lastRunAt ? Math.min(runAt - state.lastRunAt, 86_400) / 3600 : 0;
    for (const book of state.books) {
      // A book saved before turnover was tracked starts counting now.
      if (book.tradedUsd === undefined) {
        book.tradedUsd = 0;
        book.tradedSince = runAt;
      }
      accrueFunding(book, markets, hours);
      if (book.kind === "btc") stepBtcBook(book, markets, this.deps.cfg);
      else stepCopyBook(book, exposures, markets, this.deps.cfg, new Set(pendingCloses));
      recordMarks(book, markets);
    }
    const points = state.books.map((b) => ({ bookId: b.id, t: runAt, equityUsd: equityOf(b, markets) }));
    const saved = await this.deps.store.save({ ...state, lastRunAt: runAt }, points);
    this.invalidate();
    return saved === false ? [] : points;
  }

  private invalidate() {
    this.generation++;
    this.cached = undefined;
  }

  // For the dashboard: each book with its equity curve (at most CURVE_POINTS points).
  async view(sinceT = 0): Promise<PaperView> {
    if (!this.cached || Date.now() - this.cached.at > 60_000) {
      const generation = this.generation;
      const built = { view: await this.build(), at: Date.now() };
      if (generation !== this.generation) return this.view(sinceT); // a step landed meanwhile
      this.cached = built;
    }
    const view = this.cached.view;
    return sinceT ? { ...view, books: view.books.map((b) => ({ ...b, curve: b.curve.filter(([t]) => t >= sinceT) })) } : view;
  }

  private async build() {
    const state = await this.deps.store.load();
    const points = await this.deps.store.points(0);
    return {
      lastRunAt: state?.lastRunAt ?? null,
      books: (state?.books ?? []).map((b) => {
        const all = points.filter((p) => p.bookId === b.id).map((p) => [p.t, p.equityUsd] as [number, number]);
        const curve = thin(all, CURVE_POINTS);
        const equity = all.at(-1)?.[1] ?? b.startingEquityUsd;
        return {
          id: b.id,
          label: b.label,
          kind: b.kind,
          startingEquityUsd: b.startingEquityUsd,
          equityUsd: equity,
          returnPct: (equity / b.startingEquityUsd - 1) * 100,
          feesUsd: b.feesUsd,
          fundingUsd: b.fundingUsd ?? 0,
          trades: b.trades,
          // Traded notional per day ÷ starting capital, since turnover was tracked (at least an hour).
          turnoverPerDay: b.tradedUsd === undefined || b.tradedSince === undefined || !state?.lastRunAt
            ? null
            : b.tradedUsd / b.startingEquityUsd / Math.max((state.lastRunAt - b.tradedSince) / 86_400, 1 / 24),
          tradedSince: b.tradedSince ?? null,
          multiplier: b.multiplier,
          openPositions: Object.keys(b.positions).length,
          curve,
        };
      }),
    };
  }
}

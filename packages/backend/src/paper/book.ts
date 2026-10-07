// Paper books (README §4.10): the live copy strategy simulated at other sizes and
// multipliers, plus a BTC buy-and-hold benchmark. Pure, so every rule is unit-tested.
//
// Fills: at mark ± slippage (always adverse), plus a taker fee, with the live executor's leg rule
// (shared/rebalance.ts: $10 minimum, 10% drift, equity band, confirmed closes) and the 95% margin rule. Funding accrues between runs at
// the current hourly rate. Lot/tick rounding is not modelled.

// markPx: the last mark seen, so a market that disappears keeps its last value, not its entry.
export type PaperPosition = { szi: number; entryPx: number; markPx?: number };

export type PaperBook = {
  id: string;
  label: string;
  // "copy": follow the mirror's exposures × multiplier. "btc": buy and hold BTC.
  kind: "copy" | "btc";
  multiplier: number;
  startingEquityUsd: number;
  startedAt: number;
  // Collateral after realized PnL and fees.
  cashUsd: number;
  positions: Record<string, PaperPosition>;
  feesUsd: number;
  // Net funding paid (negative: received). Absent on books saved before funding was modelled.
  fundingUsd?: number;
  trades: number;
  // Traded notional (|size| × fill price) since `tradedSince` (unix seconds): the book's turnover.
  // Absent on books saved before turnover was tracked; counted from their next step.
  tradedUsd?: number;
  tradedSince?: number;
};

import { legSkip, type BandConfig } from "../../../shared/rebalance";

// fundingRate: HL's hourly funding rate (longs pay when positive).
export type Market = { markPx: number; maxLeverage: number; feeBps: number; fundingRate?: number };

export type PaperConfig = BandConfig & {
  marginCap: number;
  slippageBps: number;
};

export const newBook = (
  id: string,
  label: string,
  kind: PaperBook["kind"],
  startingEquityUsd: number,
  startedAt: number,
  multiplier = 1,
): PaperBook => ({ id, label, kind, multiplier, startingEquityUsd, startedAt, cashUsd: startingEquityUsd, positions: {}, feesUsd: 0, trades: 0, tradedUsd: 0, tradedSince: startedAt });

export const equityOf = (book: PaperBook, markets: Map<string, Market>): number => {
  let equity = book.cashUsd;
  for (const [asset, p] of Object.entries(book.positions)) {
    const mark = markets.get(asset)?.markPx ?? p.markPx ?? p.entryPx;
    equity += p.szi * (mark - p.entryPx);
  }
  return equity;
};

// Moves one position by `delta` coins at `fillPx`, booking realized PnL on the part that reduces it.
const fill = (book: PaperBook, asset: string, delta: number, fillPx: number, feeBps: number) => {
  const p = book.positions[asset] ?? { szi: 0, entryPx: fillPx };
  const reducing = p.szi !== 0 && Math.sign(delta) !== Math.sign(p.szi);
  const closed = reducing ? Math.min(Math.abs(delta), Math.abs(p.szi)) : 0;
  book.cashUsd += closed * (fillPx - p.entryPx) * Math.sign(p.szi);
  if (book.tradedUsd !== undefined) book.tradedUsd += Math.abs(delta) * fillPx;
  const fee = (Math.abs(delta) * fillPx * feeBps) / 10_000;
  book.cashUsd -= fee;
  book.feesUsd += fee;
  book.trades += 1;

  const szi = p.szi + delta;
  if (Math.abs(szi) < 1e-12) {
    delete book.positions[asset];
  } else if (Math.sign(szi) !== Math.sign(p.szi) || p.szi === 0) {
    book.positions[asset] = { szi, entryPx: fillPx }; // opened or flipped: new entry
  } else if (Math.abs(szi) > Math.abs(p.szi)) {
    const added = Math.abs(szi) - Math.abs(p.szi);
    book.positions[asset] = { szi, entryPx: (Math.abs(p.szi) * p.entryPx + added * fillPx) / Math.abs(szi) };
  } else {
    book.positions[asset] = { szi, entryPx: p.entryPx };
  }
};

// Funding for the `hours` since the last run, at each market's current rate.
export const accrueFunding = (book: PaperBook, markets: Map<string, Market>, hours: number): void => {
  if (!(hours > 0)) return;
  for (const [asset, p] of Object.entries(book.positions)) {
    const m = markets.get(asset);
    if (!m?.fundingRate) continue;
    const paid = p.szi * m.markPx * m.fundingRate * hours;
    book.cashUsd -= paid;
    book.fundingUsd = (book.fundingUsd ?? 0) + paid;
  }
};

// Remembers each position's mark, for valuing it if its market later goes missing.
export const recordMarks = (book: PaperBook, markets: Map<string, Market>): void => {
  for (const [asset, p] of Object.entries(book.positions)) {
    const m = markets.get(asset);
    if (m) p.markPx = m.markPx;
  }
};

// One mirror run: trade toward `exposures` (fraction of equity per asset) like the executor.
export const stepCopyBook = (
  book: PaperBook,
  exposures: Map<string, number>,
  markets: Map<string, Market>,
  cfg: PaperConfig,
  pendingCloses: ReadonlySet<string> = new Set(),
): void => {
  const equity = Math.max(equityOf(book, markets), 0);
  const targets = new Map<string, number>();
  for (const [asset, e] of exposures) if (markets.has(asset)) targets.set(asset, e * book.multiplier * equity);

  // 95% margin rule: scale all targets pro-rata if initial margin would exceed it, counting the
  // positions kept while their close is pending (they hold margin but aren't scaled).
  let margin = 0;
  let reserved = 0;
  for (const [asset, usd] of targets) margin += Math.abs(usd) / markets.get(asset)!.maxLeverage;
  for (const [asset, p] of Object.entries(book.positions)) {
    const m = markets.get(asset);
    if (m && pendingCloses.has(asset) && !targets.get(asset)) reserved += Math.abs(p.szi * m.markPx) / m.maxLeverage;
  }
  const room = Math.max(cfg.marginCap * equity - reserved, 0);
  const scale = margin > room && margin > 0 ? room / margin : 1;

  const assets = [...new Set([...targets.keys(), ...Object.keys(book.positions)])].sort();
  for (const asset of assets) {
    const market = markets.get(asset);
    if (!market) continue;
    const currentSz = book.positions[asset]?.szi ?? 0;
    const targetUsd = (targets.get(asset) ?? 0) * scale;
    const gapUsd = targetUsd - currentSz * market.markPx;
    if (gapUsd === 0) continue;
    const fullClose = targetUsd === 0 && currentSz !== 0;
    // The equity band scales with the multiplier, so a bucket trades like Aggressive scaled down
    // (only the exchange's $10 minimum stays fixed).
    if (legSkip({ targetUsd, currentUsd: currentSz * market.markPx, equityUsd: equity * book.multiplier, closePending: pendingCloses.has(asset) }, cfg)) continue;
    const isBuy = gapUsd > 0;
    const fillPx = market.markPx * (1 + ((isBuy ? 1 : -1) * cfg.slippageBps) / 10_000);
    const delta = fullClose ? -currentSz : gapUsd / market.markPx;
    if (!fullClose && Math.abs(delta) * fillPx < cfg.minOrderUsd) continue;
    fill(book, asset, delta, fillPx, market.feeBps);
  }
};

// Benchmark: buy BTC with the whole starting equity on the first step, then hold.
export const stepBtcBook = (book: PaperBook, markets: Map<string, Market>, cfg: PaperConfig): void => {
  if (book.trades > 0) return;
  const btc = markets.get("BTC");
  if (!btc) return;
  const fillPx = btc.markPx * (1 + cfg.slippageBps / 10_000);
  fill(book, "BTC", book.startingEquityUsd / fillPx, fillPx, btc.feeBps);
};

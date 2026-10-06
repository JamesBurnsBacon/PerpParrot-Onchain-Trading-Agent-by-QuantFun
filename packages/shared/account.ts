// Reading an HL account: positions from the per-dex clearinghouse states, equity
// from the `portfolio` info request.
//
// Why not Σ clearinghouseState.accountValue: most leaderboard traders use unified
// or portfolio-margin accounts (23 and 5 of 40 sampled with ≥ $10k on 2026-10-06),
// where per-dex accountValue is only the margin set aside on that dex. Summing it
// understated equity, and so overstated leverage, by 2–10× for those accounts.
// The portfolio request's latest accountValue is HL's own live account value in
// every mode (equal to accountValue for standard accounts), and it's the series
// the backtest's returns come from.
//
// Pure and dependency-free so the CRE workflow can use it.
import { decToE6, type AccountState } from "./copy";

export type PerpState = {
  assetPositions: { position: { coin: string; szi: string; positionValue: string } }[];
};

// The `portfolio` response: [["day", {accountValueHistory: [[ms, "value"], …], …}], …].
export type PortfolioResponse = [string, { accountValueHistory: [number, string][] }][];

export const positionsOf = (perpStates: PerpState[], eligible: ReadonlySet<string>): Map<string, bigint> => {
  const positions = new Map<string, bigint>();
  for (const state of perpStates) {
    for (const { position } of state.assetPositions) {
      if (!eligible.has(position.coin)) continue;
      const value = decToE6(position.positionValue);
      const signed = position.szi.startsWith("-") ? -value : value;
      positions.set(position.coin, (positions.get(position.coin) ?? 0n) + signed);
    }
  }
  return positions;
};

// Latest account value × 1e6 (the last point of the day window is live).
export const portfolioEquityE6 = (portfolio: PortfolioResponse): bigint => {
  const day = portfolio.find(([window]) => window === "day")?.[1].accountValueHistory;
  const last = day?.[day.length - 1];
  if (!last) throw new Error("portfolio response has no day history");
  return decToE6(last[1]);
};

export const readAccountState = (
  perpStates: PerpState[],
  portfolio: PortfolioResponse,
  eligible: ReadonlySet<string>,
): AccountState => ({ equityE6: portfolioEquityE6(portfolio), positions: positionsOf(perpStates, eligible) });

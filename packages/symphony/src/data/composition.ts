import type { Source } from "../types";
export function composeSources(
  sources: Source[],
  excludedIds: Iterable<string>,
  capital: number,
) {
  if (!Number.isFinite(capital) || capital < 100 || capital > 100_000_000)
    throw new RangeError("Capital must be between $100 and $100,000,000.");
  const excluded = new Set(excludedIds),
    activeSources = sources.filter((source) => !excluded.has(source.id));
  if (
    activeSources.some(
      (source) =>
        ![source.btc, source.eth, source.weight].every(Number.isFinite),
    )
  )
    throw new RangeError("Source exposures and weights must be finite.");
  const netBTC = activeSources.reduce((sum, source) => sum + source.btc, 0),
    netETH = activeSources.reduce((sum, source) => sum + source.eth, 0);
  const sourceGross = activeSources.reduce(
      (sum, source) => sum + Math.abs(source.btc) + Math.abs(source.eth),
      0,
    ),
    portfolioGross = Math.abs(netBTC) + Math.abs(netETH),
    activeWeight = activeSources.reduce(
      (sum, source) => sum + source.weight,
      0,
    );
  const orders = [
    { asset: "BTC", contribution: netBTC },
    { asset: "ETH", contribution: netETH },
  ]
    .filter((item) => item.contribution !== 0)
    .map(({ asset, contribution }) => ({
      asset,
      isBuy: contribution > 0,
      notionalUsd: Math.abs((contribution / 100) * capital),
      targetUsd: (contribution / 100) * capital,
      currentUsd: 0,
    }));
  return {
    activeSources,
    netBTC,
    netETH,
    sourceGross,
    portfolioGross,
    activeWeight,
    orders,
  };
}

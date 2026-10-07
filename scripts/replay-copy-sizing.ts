// Offline sizing replay for a private, point-in-time source snapshot. Never uploads its input.
// Input contains account/position data: keep it out of Git. Output contains aggregate counts only.
// Usage: bun run scripts/replay-copy-sizing.ts private-input.json [aggregate-output.json]
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { capGrossExposure, computeExposures, countedGross, leverageScaleE6, type WeightedSource } from '../packages/shared/copy';
import { planOrders, type Market } from '../packages/executor/src/planner';

type Source = {
  address: string;
  equityE6: string;
  weightE6: number;
  averageLeverage: number | null;
  positions: { asset: string; notionalE6: string }[];
};
export type ReplayInput = {
  capitalUsd: number;
  eligibleAssets: string[];
  sources: Source[];
  markets: Market[];
};

const MAX_GROSS_E9 = 5_000_000_000n;
const BUCKETS = { aggressive: 1, balanced: 0.5, conservative: 0.25 } as const;
const gross = (values: { exposureE9: bigint }[]) => values.reduce((sum, x) => sum + Math.abs(Number(x.exposureE9)) / 1e9, 0);
const counted = (values: { exposureE9: bigint }[]) => Number(countedGross(values.map(x => x.exposureE9))) / 1e9;

export function replayCopySizing(input: ReplayInput) {
  if (!(input.capitalUsd > 0) || !Number.isFinite(input.capitalUsd)) throw Error('capitalUsd must be positive');
  if (new Set(input.sources.map(s => s.address.toLowerCase())).size !== input.sources.length) throw Error('duplicate source');
  if (input.sources.reduce((sum, s) => sum + s.weightE6, 0) > 900_000) throw Error('current policy requires 10% cash');
  const eligible = new Set(input.eligibleAssets);
  const markets = new Map(input.markets.map(m => [m.name, m]));
  let excludedPositions = 0;
  let sourceCapCount = 0;
  let missingAverageLeverage = 0;
  const sources: WeightedSource[] = input.sources.map(s => {
    const positions = s.positions.filter(p => eligible.has(p.asset));
    excludedPositions += s.positions.length - positions.length;
    const scaleText = leverageScaleE6(s.averageLeverage);
    if (scaleText === null) missingAverageLeverage++;
    else {
      const held = countedGross(positions.map(p => BigInt(p.notionalE6)));
      if (held * BigInt(scaleText) * 1_000_000_000n > MAX_GROSS_E9 * BigInt(s.equityE6) * 1_000_000n) sourceCapCount++;
    }
    return {
      address: s.address, equityE6: s.equityE6, positions, weightE6: s.weightE6,
      ...(scaleText === null ? {} : { scaleE6: BigInt(scaleText), maxGrossE9: MAX_GROSS_E9 }),
    };
  });
  const beforeCap = computeExposures(sources);
  const exposures = capGrossExposure(beforeCap, MAX_GROSS_E9);
  const orderConfig = { minOrderUsd: 10, driftFraction: 0.1, equityBandFraction: 0.005, marginCap: 0.95, slippageBps: 5 };
  const buckets = Object.fromEntries(Object.entries(BUCKETS).map(([name, multiplier]) => {
    const targets = new Map(exposures.map(e => [e.asset, Number(e.exposureE9) / 1e9 * input.capitalUsd * multiplier]));
    const plan = planOrders(targets, { equityUsd: input.capitalUsd, positions: new Map() }, markets, orderConfig);
    const skipped: Record<string, number> = {};
    for (const leg of plan.skipped) skipped[leg.reason] = (skipped[leg.reason] ?? 0) + 1;
    return [name, {
      grossTargetUsd: gross(exposures) * input.capitalUsd * multiplier,
      countedGrossTargetUsd: counted(exposures) * input.capitalUsd * multiplier,
      plannedOrders: plan.orders.length,
      plannedOrderNotionalUsd: plan.orders.reduce((sum, o) => sum + Math.abs(o.notionalUsd), 0),
      skipped, marginScale: plan.marginScale, initialMarginUsd: plan.initialMarginUsd,
    }];
  }));
  return {
    scenario: 'offline-flat-follower-no-orders-sent', sourceCount: sources.length,
    inputWeightUnits: sources.reduce((sum, s) => sum + s.weightE6, 0),
    excludedPositions, missingAverageLeverage, sourceCapCount,
    targetAssetCount: exposures.length,
    physicalGrossBeforeCap: gross(beforeCap), countedGrossBeforeCap: counted(beforeCap),
    physicalGrossAfterCap: gross(exposures), countedGrossAfterCap: counted(exposures),
    netExposureAfterCap: exposures.reduce((sum, e) => sum + Number(e.exposureE9) / 1e9, 0),
    aggregateCapBinds: counted(beforeCap) > 5,
    buckets,
  };
}

if (import.meta.main) {
  const [inputPath, outputPath] = process.argv.slice(2);
  if (!inputPath) throw Error('Usage: bun run scripts/replay-copy-sizing.ts private-input.json [aggregate-output.json]');
  const bytes = readFileSync(inputPath);
  const input = JSON.parse(bytes.toString()) as ReplayInput;
  const result = { ...replayCopySizing(input), inputSha256: createHash('sha256').update(bytes).digest('hex') };
  const output = JSON.stringify(result, null, 2);
  if (outputPath) writeFileSync(outputPath, output + '\n');
  console.log(output);
}

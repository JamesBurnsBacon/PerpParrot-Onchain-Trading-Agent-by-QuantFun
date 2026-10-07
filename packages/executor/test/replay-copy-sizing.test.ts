import { strict as assert } from 'node:assert';
import { test } from 'bun:test';
import { replayCopySizing, type ReplayInput } from '../../../scripts/replay-copy-sizing.ts';

const address = (digit: string) => `0x${digit.repeat(40)}`;
const source = (digit: string) => ({
  address: address(digit), equityE6: '1000000000', weightE6: 300_000,
  averageLeverage: 0.1,
  positions: [
    { asset: 'BTC', notionalE6: '300000000' },
    { asset: 'ETH', notionalE6: '-100000000' },
    { asset: 'NOT_ELIGIBLE', notionalE6: '900000000' },
  ],
});

test('offline replay uses normalized, hedge-aware 5x source caps and executor order rules', () => {
  const input: ReplayInput = {
    capitalUsd: 470, eligibleAssets: ['BTC', 'ETH'],
    sources: [source('1'), source('2'), source('3')],
    markets: [
      { name: 'BTC', assetId: 0, szDecimals: 5, maxLeverage: 40, markPx: 100_000, tradable: true },
      { name: 'ETH', assetId: 1, szDecimals: 4, maxLeverage: 25, markPx: 4_000, tradable: true },
    ],
  };
  const result = replayCopySizing(input);
  assert.equal(result.sourceCount, 3);
  assert.equal(result.excludedPositions, 3);
  assert.equal(result.sourceCapCount, 3); // each source counts 7x before its 5x cap
  assert.ok(result.physicalGrossAfterCap > 5); // both sides' notionals really exceed 5x
  assert.ok(result.countedGrossAfterCap <= 5); // #74 counts the minority side at half
  assert.ok(Math.abs(result.countedGrossAfterCap - 4.5) < 1e-8);
  assert.equal(result.aggregateCapBinds, false);
  assert.equal(result.buckets.aggressive.plannedOrders, 2);
  assert.equal(result.buckets.balanced.plannedOrders, 2);
  assert.equal(result.buckets.conservative.plannedOrders, 2);
  assert.ok(!JSON.stringify(result).includes(address('1'))); // aggregate output has no accounts
  assert.ok(!JSON.stringify(result).includes('NOT_ELIGIBLE'));
});

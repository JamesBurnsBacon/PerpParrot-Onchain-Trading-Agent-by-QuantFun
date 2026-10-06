import { test, expect } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fixture } from '../tests/support/review-fixture.ts';
import type { FrozenConfiguration } from '../packages/shared/frozen.ts';
import { runServiceProof, serviceProofSchema } from './service-loop.ts';

test('actual service modules: HTTP targets, durable execution receipt, faults and recovery', async () => {
  const configuration = fixture().configuration as unknown as FrozenConfiguration;
  const assets = ['BTC', 'ETH', 'SOL', 'AVAX', 'HYPE'];
  const snapshot = { snapshotId: 'service-fixture', runAt: 1_791_301_200, startedAt: 1_791_301_200, takenAt: 1_791_301_200,
    configuration, eligibleAssets: assets, sources: configuration.sources.map((s, i) => ({ address: s.sourceAddress,
      equityE6: '100000000000', positions: [{ asset: assets[i], notionalE6: '100000000000' }],
    })),
  };
  const directory = mkdtempSync(join(tmpdir(), 'perpparrot-service-proof-'));
  const first = await runServiceProof(directory, { configuration, snapshot });
  expect(first.plannedOrders).toBe(5);
  expect(first.publicDashboardRunCount).toBe(12);
  expect(first.scenarios.filter(s => s.status === 'executed')).toHaveLength(2);
  expect(first.scenarios.find(s => s.name === 'database-before-dispatch')?.dryRunActions).toBe(0);
  expect(first.scenarios.find(s => s.name === 'database-after-leverage-dispatch')?.dryRunActions).toBe(1);
  expect(first.scenarios.find(s => s.name === 'database-after-order-dispatch')?.dryRunActions).toBe(6);
  expect(first.liveOrdersSubmitted).toBe(0);
  expect(Object.values(first.checks).every(Boolean)).toBe(true);
  expect(serviceProofSchema.safeParse({ ...first, plannedOrders: 0 }).success).toBe(false);
  const repeated = await runServiceProof(directory, { configuration, snapshot });
  expect(repeated).toEqual(first);
}, 60_000);

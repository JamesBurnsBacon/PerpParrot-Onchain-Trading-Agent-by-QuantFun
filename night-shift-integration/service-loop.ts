import { PGlite } from '@electric-sql/pglite';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { SQL } from 'bun';
import { z } from 'zod';
import { canonical } from './contracts.ts';
import { SnapshotService, SnapshotError } from '../packages/backend/src/service.ts';
import { EligibilityTracker } from '../packages/backend/src/eligibility.ts';
import { FileConfigurationSource } from '../packages/backend/src/configuration-source.ts';
import { PostgresSnapshotStore, PostgresEligibilityStore, PostgresPaperStore } from '../packages/backend/src/pg-store.ts';
import { PaperService, defaultBooks } from '../packages/backend/src/paper/service.ts';
import { keccakUtf8 } from '../packages/backend/src/snapshot.ts';
import type { HlReader } from '../packages/backend/src/hyperliquid.ts';
import { PostgresStore } from '../packages/executor/src/pg-store.ts';
import { Runner } from '../packages/executor/src/runner.ts';
import { createApp } from '../packages/executor/src/app.ts';
import { createExchange } from '../packages/executor/src/exchange.ts';
import { backendTargets } from '../packages/executor/src/targets.ts';
import type { InfoFn } from '../packages/executor/src/hyperliquid.ts';
import type { RunRecord } from '../packages/executor/src/store.ts';
import { targetsFromSnapshot } from '../packages/shared/copy.ts';
import type { FrozenConfiguration } from '../packages/shared/frozen.ts';
import type { PositionsSnapshot } from '../packages/shared/snapshot.ts';

const hash = z.string().regex(/^0x[0-9a-f]{64}$/);
export const servicePlanSchema=z.object({
  orders:z.array(z.object({asset:z.string(),assetId:z.number().int(),isBuy:z.boolean(),price:z.string(),size:z.string(),
    reduceOnly:z.boolean(),notionalUsd:z.number().finite(),targetUsd:z.number().finite(),currentUsd:z.number().finite()}).strict()),
  skipped:z.array(z.object({asset:z.string(),reason:z.enum(['BELOW_DRIFT','BELOW_MIN_ORDER','UNKNOWN_MARKET','SIZE_ROUNDS_TO_ZERO','NOT_TRADABLE','LEVERAGE_FAILED']),
    targetUsd:z.number().finite(),currentUsd:z.number().finite()}).strict()),
  marginScale:z.number().finite(),initialMarginUsd:z.number().finite(),
}).strict();
export const serviceProofSchema = z.object({
  schemaVersion: z.literal('night-service-proof.v1'),
  mode: z.literal('controlled-fixture-http-dry-run'),
  storage: z.literal('actual-production-store-queries-on-local-pglite'),
  configurationHash: hash,
  snapshotHash: hash,
  runId: z.string().regex(/^mirror-\d+$/),
  plannedOrders: z.number().int().positive(),
  equityUsd: z.number().finite().positive(),
  plan: servicePlanSchema,
  liveOrdersSubmitted: z.literal(0),
  publicDashboardRunCount: z.number().int().positive(),
  paperBookCount: z.literal(4),
  checks: z.object({
    sameFrozenConfiguration: z.literal(true),
    snapshotHashRecomputed: z.literal(true),
    targetExposuresRecomputed: z.literal(true),
    nonemptyDryRunResults: z.literal(true),
    concurrentDuplicateNoOp: z.literal(true),
    restartDuplicateNoOp: z.literal(true),
    restartSnapshotUnchanged: z.literal(true),
    restartPausePersisted: z.literal(true),
    restartPaperPersisted: z.literal(true),
    journalFaultHeldAfterRestart: z.literal(true),
    orderJournalFaultHeldAfterRestart: z.literal(true),
    lastBatchFailureRecorded: z.literal(true),
    unresolvedResumeBlocked: z.literal(true),
    reconciliationStaysPaused: z.literal(true),
    nextRunRecovered: z.literal(true),
  }).strict(),
  scenarios: z.array(z.object({
    name: z.enum(['success', 'wrong-configuration', 'wrong-account', 'expired-run', 'backend-unavailable', 'paused', 'database-before-dispatch', 'database-after-leverage-dispatch', 'restart-unresolved-journal', 'database-after-order-dispatch', 'restart-unresolved-order-journal', 'recovered']),
    runId: z.string().regex(/^mirror-\d+$/),
    status: z.enum(['executed', 'failed', 'skipped_paused']),
    dryRunActions: z.number().int().nonnegative(),
    error: z.string().nullable(),
  }).strict()).length(12),
  boundaries: z.array(z.string()).length(4),
}).strict();
export type ServiceProof = z.infer<typeof serviceProofSchema>;
export const assertServiceProof = (value: unknown): ServiceProof => serviceProofSchema.parse(value);

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`SERVICE_PROOF: ${message}`);
}
const wire = (value: unknown) => JSON.stringify(value, (_key, item) => typeof item === 'bigint' ? item.toString() : item);
const e6Decimal = (n: string) => {
  const b = BigInt(n), a = b < 0n ? -b : b;
  return `${b < 0n ? '-' : ''}${a / 1_000_000n}.${(a % 1_000_000n).toString().padStart(6, '0')}`;
};

/**
 * SQL transport adapter only: all table queries and constraints are the production
 * Postgres stores/migrations. PGlite is an embedded PostgreSQL engine; this does not
 * exercise Bun's network driver, Supabase, pooler or multi-process advisory locks.
 */
type Fault = { point: 'none' | 'before-journal' | 'after-dispatch' | 'after-order-dispatch' };
function sqlAdapter(db: PGlite, fault: Fault): SQL {
  const tagFor = (client: Pick<PGlite, 'query'>): unknown => {
    const tag = async (parts: TemplateStringsArray, ...values: unknown[]) => {
      const text = parts.reduce((out, part, i) => out + (i ? `$${i}` : '') + part, '');
      if (fault.point === 'before-journal' && /insert into executor_order_batches/.test(text)) {
        fault.point = 'none'; throw new Error('INJECTED_DATABASE_BEFORE_DISPATCH');
      }
      if (fault.point === 'after-dispatch' && /update executor_order_batches set state/.test(text)) {
        fault.point = 'none'; throw new Error('INJECTED_DATABASE_AFTER_DISPATCH');
      }
      if (fault.point === 'after-order-dispatch' && /update executor_order_batches set state/.test(text) &&
          typeof values[2] === 'string' && !values[2].includes(':leverage:')) {
        fault.point = 'none'; throw new Error('INJECTED_DATABASE_AFTER_ORDER_DISPATCH');
      }
      const params = values.map(v => v instanceof Date ? v.toISOString() : v !== null && typeof v === 'object' ? wire(v) : v);
      return (await client.query(text, params)).rows;
    };
    return Object.assign(tag, { begin: (fn: (tx: SQL) => Promise<unknown>) => db.transaction(tx => fn(tagFor(tx) as SQL)) });
  };
  return tagFor(db) as SQL;
}

/** Ordinary HTTP service proof. Synthetic upstream data, real business modules. */
export async function runServiceProof(outPath: string, input: {
  configuration: FrozenConfiguration;
  snapshot: PositionsSnapshot;
}): Promise<ServiceProof> {
  mkdirSync(outPath, { recursive: true });
  // A new scratch database per invocation prevents prior successful claims from
  // making a repeat test pass without executing. Paths/ports never enter evidence.
  const directory = mkdtempSync(join(outPath, 'proof-'));
  const dbPath = join(directory, 'postgres');
  const configPath = join(directory, 'frozen-fixture.json');
  // JSONB may return the same frozen object with a different property order.
  // Canonical fixture bytes keep replay snapshot hashes stable across DB reopen.
  writeFileSync(configPath, canonical(input.configuration));
  const base = input.snapshot.runAt;
  assert(Number.isSafeInteger(base) && base % 600 === 0, 'runAt must use the ten-minute clock');
  assert(input.configuration.configurationHash === input.snapshot.configuration.configurationHash, 'configuration identity');
  assert(input.snapshot.sources.length >= 5, 'five controlled sources required');
  let nowMs = base * 1000;
  let db = new PGlite(dbPath);
  for (const migration of ['20261006120000_mirror.sql', '20261006180000_executor_order_journal.sql'])
    await db.exec(readFileSync(new URL('../supabase/migrations/' + migration, import.meta.url), 'utf8'));
  const fault: Fault = { point: 'none' };
  let sql = sqlAdapter(db, fault);
  let store = new PostgresStore(sql);
  let snapshots = new PostgresSnapshotStore(sql);
  let paperStore = new PostgresPaperStore(sql);
  const assets = [...new Set(['BTC', ...input.snapshot.eligibleAssets])].sort();
  const prices = new Map(assets.map((asset, i) => [asset, asset === 'BTC' ? 100_000 : asset === 'ETH' ? 2_500 : 100 + i]));
  const sources = new Map(input.snapshot.sources.map(s => [s.address, s]));
  const sourceFor = (address: string) => { const found = sources.get(address); assert(found, 'unregistered fixture source'); return found; };
  const hl: HlReader = {
    async perp(user, dex) {
      return { assetPositions: sourceFor(user).positions.filter(p => dex === 'xyz' ? p.asset.startsWith('xyz:') : !p.asset.includes(':')).map(p => ({ position: {
        coin: p.asset, szi: BigInt(p.notionalE6) < 0n ? '-1' : '1', positionValue: e6Decimal(p.notionalE6.replace(/^-/, '')),
      } })) };
    },
    async portfolio(user) { return [['day', { accountValueHistory: [[nowMs, e6Decimal(sourceFor(user).equityE6)]] }]]; },
  };
  const info: InfoFn = async <T>(request: Record<string, unknown>): Promise<T> => {
    let response: unknown;
    switch (request.type) {
      case 'perpDexs': response = [null, { name: 'xyz' }]; break;
      case 'metaAndAssetCtxs': {
        const filtered = assets.filter(a => request.dex === 'xyz' ? a.startsWith('xyz:') : !a.includes(':'));
        response = [{ collateralToken: 0, universe: filtered.map(name => ({ name, szDecimals: 5, maxLeverage: 10 })) }, filtered.map(a => ({ markPx: String(prices.get(a)), openInterest: '1000000' }))]; break;
      }
      case 'clearinghouseState': response = { assetPositions: [] }; break;
      case 'portfolio': response = [['day', { accountValueHistory: [[nowMs, '10000']] }]]; break;
      default: throw new Error('UNEXPECTED_CONTROLLED_HL_READ');
    }
    return response as T;
  };
  const makePaper = () => new PaperService({ store: paperStore, specs: defaultBooks(),
    cfg: { minOrderUsd: 10, driftFraction: 0.1, marginCap: 0.95, slippageBps: 5 },
    markets: async () => new Map(assets.map(a => [a, { markPx: prices.get(a)!, maxLeverage: 10, feeBps: 4.5, fundingRate: 0 }])),
  });
  let paper = makePaper();
  const makeService = () => new SnapshotService({ configurations: new FileConfigurationSource(configPath, input.configuration.configurationHash),
    eligibility: new EligibilityTracker(new PostgresEligibilityStore(sql), async () => new Map(assets.map(a => [a, 100_000_000]))),
    store: snapshots, nowMs: () => nowMs, hl,
  });
  let service = makeService();
  let backendMode: 'normal' | 'unavailable' | 'wrong-account' = 'normal';
  // server.ts owns process startup/env/network defaults and is not injectable. This
  // thin route adapter follows its /snapshots, /targets and /paper contracts while
  // calling the same SnapshotService, copy math and PaperService implementations.
  const backend = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
    const path = new URL(request.url).pathname;
    if (backendMode === 'unavailable') return Response.json({ error: 'INJECTED_BACKEND_UNAVAILABLE' }, { status: 503 });
    if (path === '/paper') return Response.json(await paper.view());
    const match = /^\/(snapshots|targets)\/(\d+)$/.exec(path);
    if (!match) return new Response('not found', { status: 404 });
    try {
      const runAt = Number(match[2]), json = await service.get(runAt);
      if (match[1] === 'snapshots') return new Response(json, { headers: { 'Content-Type': 'application/json' } });
      const snapshot = JSON.parse(json) as PositionsSnapshot;
      return Response.json({ runId: `mirror-${runAt}`, runAt, snapshotHash: keccakUtf8(json),
        configurationHash: snapshot.configuration.configurationHash,
        account: backendMode === 'wrong-account' ? '0x' + 'f'.repeat(40) : snapshot.configuration.account,
        exposures: targetsFromSnapshot(snapshot).map(e => ({ asset: e.asset, exposureE9: e.exposureE9.toString() })),
      });
    } catch (error) { return Response.json({ error: (error as Error).message }, { status: error instanceof SnapshotError ? error.status : 502 }); }
  } });
  const backendUrl = `http://127.0.0.1:${backend.port}`;
  const exchange = createExchange({ dryRun: true });
  let pinnedHash = input.configuration.configurationHash;
  const makeRunner = () => new Runner({ store, exchange, info, alert: async () => {}, now: () => nowMs,
    targets: backendTargets(backendUrl), config: { account: input.configuration.account as `0x${string}`,
      frozenConfigurationHash: pinnedHash, maxGrossLeverage: input.configuration.policy.maxGrossLeverage,
      runTtlSeconds: 300, runTimeoutMs: 10_000, plan: { minOrderUsd: 10, driftFraction: 0.1, marginCap: 0.95, slippageBps: 50 } },
  });
  let runner = makeRunner();
  const admin = 'local-fixture-no-authority';
  const makeApp = () => createApp({ runner, store, adminToken: admin, cronSecret: admin, now: () => nowMs,
    status: () => ({ dryRun: true, account: input.configuration.account, frozenConfigurationHash: pinnedHash, store: 'pglite-test-adapter' }), log: () => {},
  });
  let app = makeApp();
  const executor = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: request => app(request) });
  const executorUrl = `http://127.0.0.1:${executor.port}`;
  const post = async (path: string, body?: unknown) => fetch(executorUrl + path, { method: 'POST',
    headers: { authorization: 'Bearer ' + admin, 'content-type': 'application/json', 'x-operator': 'fixture-operator' }, body: body === undefined ? undefined : wire(body) });
  const get = (path: string) => fetch(executorUrl + path);
  const scenarios: ServiceProof['scenarios'] = [];
  let index = 0;
  async function scenario(name: ServiceProof['scenarios'][number]['name'], expected: RunRecord['status'], expectedError?: string, offsetSeconds = 0) {
    const runAt = base + index++ * 600; nowMs = (runAt + offsetSeconds) * 1000;
    const before = exchange.recorded().length;
    const response = await post('/admin/run', { runAt });
    assert(response.status === 200, `HTTP trigger ${name}`);
    const summary = await response.json() as { status: string };
    const record = (await store.recentRuns(50)).find(r => r.runId === `mirror-${runAt}`);
    assert(record && summary.status === expected && record.status === expected, `${name} expected ${expected}`);
    if (expectedError) assert(record.error?.includes(expectedError), `${name} error not propagated`);
    const actions = exchange.recorded().length - before;
    if (expected !== 'executed' && name !== 'database-after-leverage-dispatch' && name !== 'database-after-order-dispatch') assert(actions === 0, `${name} performed an exchange action`);
    scenarios.push({ name, runId: record.runId, status: record.status, dryRunActions: actions, error: record.error ?? null });
    return record;
  }
  const restart = async () => {
    await db.close(); db = new PGlite(dbPath); sql = sqlAdapter(db, fault); store = new PostgresStore(sql);
    snapshots = new PostgresSnapshotStore(sql); paperStore = new PostgresPaperStore(sql); paper = makePaper(); service = makeService(); runner = makeRunner(); app = makeApp();
  };
  try {
    // Race the first claim on a fresh slot, not just retries of an existing claim.
    const firstResponses = await Promise.all([post('/admin/run', { runAt: base }), post('/admin/run', { runAt: base })]);
    const firstOutcomes = await Promise.all(firstResponses.map(response => response.json() as Promise<{status: string}>));
    assert(firstResponses.every(response => response.status === 200), 'first-claim HTTP responses');
    assert(firstOutcomes.map(outcome => outcome.status).sort().join(',') === 'duplicate,executed', 'fresh concurrent first claim');
    const success = (await store.recentRuns(1))[0];
    assert(success?.runId === `mirror-${base}` && success.status === 'executed', 'first run receipt');
    index = 1;
    scenarios.push({name:'success',runId:success.runId,status:success.status,dryRunActions:exchange.recorded().length,error:success.error??null});
    assert(success.plan && success.plan.orders.length > 0, 'success needs nonempty order plan');
    assert(success.results && success.results.length === success.plan.orders.length && success.results.every(r => r.status === 'dry_run'), 'nonempty dry run result');
    const snapshotText = await (await fetch(backendUrl + `/snapshots/${base}`)).text();
    const snapshotHash = keccakUtf8(snapshotText);
    const evidence = success.evidence as { snapshotHash: string; configurationHash: string; exposures: unknown };
    assert(evidence.snapshotHash === snapshotHash, 'stored snapshot bytes/evidence mismatch');
    assert(evidence.configurationHash === input.configuration.configurationHash, 'freeze/evidence mismatch');
    const recomputed = targetsFromSnapshot(JSON.parse(snapshotText));
    assert(wire(recomputed) === wire(evidence.exposures), 'target math/evidence mismatch');
    assert((JSON.parse(snapshotText) as PositionsSnapshot).configuration.account === input.configuration.account, 'account mismatch');
    const beforeDuplicates = exchange.recorded().length;
    const duplicates = await Promise.all([post('/admin/run', { runAt: base }), post('/admin/run', { runAt: base })]);
    assert((await Promise.all(duplicates.map(r => r.json()))).every(r => (r as { status: string }).status === 'duplicate'), 'duplicate HTTP trigger not a no-op');
    assert(exchange.recorded().length === beforeDuplicates, 'duplicate issued actions');
    const paperPoints = await paper.step(base, snapshotText);
    assert(paperPoints.length === 4, 'four paper books');
    assert((await paper.step(base, snapshotText)).length === 0, 'paper step deduplication');
    await post('/admin/pause');
    await restart();
    assert((await store.getControls()).paused, 'pause lost on restart');
    assert((await (await post('/admin/run', { runAt: base })).json() as { status: string }).status === 'duplicate', 'claim lost on restart');
    assert(await snapshots.get(base) === snapshotText, 'snapshot changed on restart');
    const paperView = await (await fetch(backendUrl + '/paper')).json() as { lastRunAt: number; books: unknown[] };
    assert(paperView.lastRunAt === base && paperView.books.length === 4, 'paper state lost on restart');
    await post('/admin/resume');
    pinnedHash = '0x' + 'e'.repeat(64); runner = makeRunner(); app = makeApp();
    await scenario('wrong-configuration', 'failed', 'configuration mismatch');
    pinnedHash = input.configuration.configurationHash; runner = makeRunner(); app = makeApp();
    backendMode = 'wrong-account'; await scenario('wrong-account', 'failed', 'account mismatch'); backendMode = 'normal';
    await scenario('expired-run', 'failed', 'expired before execution', 301);
    backendMode = 'unavailable'; await scenario('backend-unavailable', 'failed', 'HTTP 503'); backendMode = 'normal';
    await post('/admin/pause'); await scenario('paused', 'skipped_paused'); await post('/admin/resume');
    // A new Runner resets the process-local leverage cache, exercising the durable
    // leverage journal before any synthetic exchange action in each fault case.
    runner = makeRunner(); app = makeApp(); fault.point = 'before-journal';
    await scenario('database-before-dispatch', 'failed', 'INJECTED_DATABASE_BEFORE_DISPATCH');
    runner = makeRunner(); app = makeApp(); fault.point = 'after-dispatch';
    await scenario('database-after-leverage-dispatch', 'failed', 'INJECTED_DATABASE_AFTER_DISPATCH');
    assert((await store.unresolvedOrderBatches()).length === 1, 'ambiguous journal entry missing');
    await restart();
    await scenario('restart-unresolved-journal', 'skipped_paused', 'need reconciliation');
    const unresolvedResponse = await fetch(executorUrl + '/admin/order-batches', { headers: { authorization: 'Bearer ' + admin } });
    const unresolved = await unresolvedResponse.json() as { id: string; state: string }[];
    assert(unresolved.length === 1 && unresolved[0].state === 'dispatching', 'operator journal listing');
    assert((await post('/admin/resume')).status === 409, 'resume must be blocked by unresolved journal');
    const reconciliation = await post('/admin/reconcile-batch', { id: unresolved[0].id,
      evidence: 'Controlled dry-run drill only: captured transport was local; no network order was submitted. Recorded action reviewed.' });
    assert(reconciliation.status === 200 && (await store.getControls()).paused, 'reconciliation must remain paused');
    assert((await post('/admin/resume')).status === 200, 'explicit resume failed');
    // Last IOC batch: no unsent tail exists to signal a journal failure. This
    // regression must preserve observed dry-run results yet mark the run failed.
    runner = makeRunner(); app = makeApp(); fault.point = 'after-order-dispatch';
    const orderFault = await scenario('database-after-order-dispatch', 'failed', 'INJECTED_DATABASE_AFTER_ORDER_DISPATCH');
    assert(orderFault.results && orderFault.results.length > 0 && orderFault.results.every(r => r.status === 'dry_run'), 'order observations lost after final-batch journal failure');
    assert((await store.getControls()).paused, 'final-batch journal failure did not pause');
    await restart();
    await scenario('restart-unresolved-order-journal', 'skipped_paused', 'need reconciliation');
    const orderUnresolved = await store.unresolvedOrderBatches();
    assert(orderUnresolved.length === 1 && orderUnresolved[0].kind === 'orders' && orderUnresolved[0].state === 'dispatching', 'IOC journal not durable');
    assert((await post('/admin/resume')).status === 409, 'unresolved IOC must block resume');
    assert((await post('/admin/reconcile-batch', { id: orderUnresolved[0].id,
      evidence: 'Controlled final IOC dry-run drill: local transport response reviewed; no real order submitted; preserved client order identifiers checked.' })).status === 200, 'IOC reconciliation failed');
    assert((await store.getControls()).paused, 'IOC reconciliation must remain paused');
    assert((await post('/admin/resume')).status === 200, 'IOC explicit resume failed');
    await scenario('recovered', 'executed');
    const dashboard = await (await get('/runs?limit=50')).json() as RunRecord[];
    const dashboardRun = dashboard.find(r => r.runId === success.runId);
    assert(dashboardRun?.dryRun === true && dashboardRun.plan?.orders.length === success.plan.orders.length, 'dashboard run receipt');
    assert(wire(dashboardRun.evidence) === wire(success.evidence), 'dashboard evidence changed');
    assert(dashboard.length === scenarios.length, 'dashboard run count');
    const result: ServiceProof = assertServiceProof({
      schemaVersion: 'night-service-proof.v1', mode: 'controlled-fixture-http-dry-run', storage: 'actual-production-store-queries-on-local-pglite',
      configurationHash: input.configuration.configurationHash, snapshotHash, runId: success.runId,
      plannedOrders: success.plan.orders.length, equityUsd: success.equityUsd, plan: success.plan,
      liveOrdersSubmitted: 0, publicDashboardRunCount: dashboard.length, paperBookCount: 4,
      checks: { sameFrozenConfiguration: true, snapshotHashRecomputed: true, targetExposuresRecomputed: true, nonemptyDryRunResults: true,
        concurrentDuplicateNoOp: true, restartDuplicateNoOp: true, restartSnapshotUnchanged: true, restartPausePersisted: true,
        restartPaperPersisted: true, journalFaultHeldAfterRestart: true, orderJournalFaultHeldAfterRestart: true, lastBatchFailureRecorded: true,
        unresolvedResumeBlocked: true, reconciliationStaysPaused: true, nextRunRecovered: true },
      scenarios,
      boundaries: [
        'Synthetic source/account/market inputs and local dry-run exchange transport; no real orders or provider calls.',
        'Actual production SnapshotService, copy math, executor HTTP app, Runner, SDK dry transport, stores and SQL migrations.',
        'Backend HTTP routing is a thin test adapter; embedded PGlite replaces Bun SQL transport, not production table queries.',
        'Local database close/reopen and fault injection; no hosted deployment, multi-process advisory-lock, pooler or funded-execution claim.',
      ],
    });
    writeFileSync(join(directory, 'proof.json'), JSON.stringify(result, null, 2) + '\n');
    writeFileSync(join(directory, 'dashboard-runs.json'), wire(dashboard) + '\n');
    writeFileSync(join(directory, 'snapshot.json'), snapshotText);
    return result;
  } finally { backend.stop(true); executor.stop(true); await db.close(); }
}

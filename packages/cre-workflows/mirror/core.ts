import {commitment} from '../../shared/src/commitments.ts';
import {requireConfirmedFreeze, WEIGHT_UNITS} from '../../shared/src/frozen.ts';
import type {ConfirmedFreeze, FrozenConfiguration} from '../../shared/src/frozen.ts';

/** Monetary fields are canonical decimal micro-USD integers. No binary-float sizing. */
import type {MirrorPlan, Position} from '../../shared/src/mirror-plan.ts';
export type {MirrorPlan, Position} from '../../shared/src/mirror-plan.ts';
export interface AccountState {
  address: string;
  observedAtMs: number;
  equityMicros: string;
  positions: Position[];
}
export interface PositionsSnapshot {
  configurationHash: string;
  publishedAtMs: number;
  sources: AccountState[];
  snapshotHash: string;
}
export interface MarketLimit {market: string; maxAbsNotionalMicros: string; reduceOnly: boolean}
export interface MirrorInput {
  configuration: FrozenConfiguration;
  confirmedFreeze: ConfirmedFreeze;
  snapshot: PositionsSnapshot;
  account: AccountState;
  checks: AccountState[];
  /** Agreed sample supplied by trusted orchestration; this core does not invent randomness. */
  sampledAddresses: string[];
  markets: MarketLimit[];
  nowMs: number;
  maxStateAgeMs: number;
  runId: string;
}
export type MirrorResult = {status: 'HOLD'; reason: string} | {status: 'READY'; plan: MirrorPlan};
const MONEY_BOUND = 10n ** 24n;
function ensure(ok: boolean, reason: string): asserts ok {if (!ok) throw new Error(reason);}
function money(value: string): bigint {
  ensure(typeof value === 'string' && /^(0|-?[1-9][0-9]{0,23})$/.test(value), 'invalid money encoding');
  const amount = BigInt(value);
  ensure(abs(amount) < MONEY_BOUND, 'money out of range');
  return amount;
}
function abs(value: bigint): bigint {return value < 0n ? -value : value;}
function positions(state: AccountState, nowMs: number, ageMs: number): Map<string, bigint> {
  ensure(/^0x[0-9a-f]{40}$/.test(state.address), 'invalid account identity');
  ensure(Number.isSafeInteger(state.observedAtMs) && state.observedAtMs <= nowMs && nowMs - state.observedAtMs <= ageMs, 'stale account state');
  ensure(money(state.equityMicros) > 0n, 'nonpositive equity');
  ensure(Array.isArray(state.positions) && state.positions.length <= 100, 'oversized positions');
  const result = new Map<string, bigint>();
  for (const position of state.positions) {
    ensure(/^[A-Za-z0-9:_-]{1,64}$/.test(position.market) && !result.has(position.market), 'invalid/duplicate position market');
    result.set(position.market, money(position.notionalMicros));
  }
  return result;
}
export function snapshotHash(snapshot: Omit<PositionsSnapshot, 'snapshotHash'>): string {
  return commitment('perpparrot:positions:v1', snapshot);
}
/** Paper-only compiler: no model, HTTP, report signing, contract writes or orders. */
export function buildMirrorPlan(input: MirrorInput): MirrorResult {
  try {return {status: 'READY', plan: compile(input)};}
  catch (error) {return {status: 'HOLD', reason: error instanceof Error ? error.message : 'invalid mirror input'};}
}
function compile(input: MirrorInput): MirrorPlan {
  const {configuration: config, nowMs, maxStateAgeMs: ageMs, snapshot} = input;
  requireConfirmedFreeze(config, input.confirmedFreeze, nowMs);
  ensure(Number.isSafeInteger(ageMs) && ageMs > 0 && ageMs <= 600_000, 'invalid freshness policy');
  ensure(/^[A-Za-z0-9:_-]{1,100}$/.test(input.runId), 'invalid run identity');
  ensure(snapshot.configurationHash === config.configurationHash && Number.isSafeInteger(snapshot.publishedAtMs) && snapshot.publishedAtMs <= nowMs && nowMs - snapshot.publishedAtMs <= ageMs, 'stale/mismatched snapshot');
  const {snapshotHash: suppliedHash, ...payload} = snapshot;
  ensure(suppliedHash === snapshotHash(payload), 'snapshot commitment mismatch');
  ensure(snapshot.sources.length === config.sources.length, 'incomplete source coverage');
  const sourceStates = new Map(snapshot.sources.map(state => [state.address, state]));
  ensure(sourceStates.size === config.sources.length && config.sources.every(source => sourceStates.has(source.sourceAddress)), 'source identity mismatch');
  ensure(snapshot.sources.every(state => state.observedAtMs <= snapshot.publishedAtMs), 'snapshot contains observations after publication');
  const sourcePositions = new Map(snapshot.sources.map(state => [state.address, positions(state, nowMs, ageMs)]));
  const actual = positions(input.account, nowMs, ageMs);
  ensure(input.account.address === config.account, 'wrong execution account');
  const sample = input.sampledAddresses;
  ensure(sample.length === Math.min(10, config.sources.length) && new Set(sample).size === sample.length && sample.every(address => sourceStates.has(address)), 'invalid spot-check sample');
  const checks = new Map(input.checks.map(state => [state.address, state]));
  ensure(checks.size === sample.length && input.checks.length === sample.length && sample.every(address => checks.has(address)), 'incomplete spot-checks');
  for (const address of sample) {
    const checked = checks.get(address)!;
    const live = positions(checked, nowMs, ageMs);
    const saved = sourcePositions.get(address)!;
    // Sum absolute per-market differences: opposite directions cannot cancel out.
    const discrepancy = [...new Set([...saved.keys(), ...live.keys()])].reduce((sum, market) => sum + abs((saved.get(market) ?? 0n) - (live.get(market) ?? 0n)), 0n);
    ensure(discrepancy * 20n <= money(checked.equityMicros), 'spot-check discrepancy exceeds 5% equity');
    ensure(abs(money(sourceStates.get(address)!.equityMicros) - money(checked.equityMicros)) * 20n <= money(checked.equityMicros), 'spot-check equity discrepancy exceeds 5%');
  }
  ensure(input.markets.length > 0 && input.markets.length <= 100, 'invalid market coverage');
  const limits = new Map(input.markets.map(limit => [limit.market, limit]));
  ensure(limits.size === input.markets.length, 'duplicate market limit');
  for (const limit of input.markets) ensure(/^[A-Za-z0-9:_-]{1,64}$/.test(limit.market) && money(limit.maxAbsNotionalMicros) > 0n && typeof limit.reduceOnly === 'boolean', 'invalid market limit');
  ensure([...actual].every(([market, amount]) => amount === 0n || limits.has(market)), 'held market lacks close policy');
  const active = config.sources.filter(source => [...sourcePositions.get(source.sourceAddress)!.values()].some(amount => amount !== 0n));
  const activeUnits = active.reduce((sum, source) => sum + source.weightUnits, 0);
  const allocatedUnits = WEIGHT_UNITS - config.cashUnits;
  const target = new Map<string, bigint>();
  const equity = money(input.account.equityMicros);
  for (const source of active) {
    // Active-source renormalization must not silently violate the frozen source ceiling.
    ensure(BigInt(source.weightUnits) * BigInt(allocatedUnits) <= BigInt(source.ceilingUnits) * BigInt(activeUnits), 'active-source concentration exceeds ceiling');
    const state = sourceStates.get(source.sourceAddress)!;
    for (const [market, amount] of sourcePositions.get(source.sourceAddress)!) {
      if (!limits.has(market)) continue; // Ineligible assets are disclosed tracking error.
      const slice = amount * equity * BigInt(source.weightUnits) * BigInt(allocatedUnits) / (money(state.equityMicros) * BigInt(activeUnits) * BigInt(WEIGHT_UNITS));
      target.set(market, (target.get(market) ?? 0n) + slice);
    }
  }
  for (const [market, limit] of limits) {
    let desired = target.get(market) ?? 0n;
    const current = actual.get(market) ?? 0n;
    if (limit.reduceOnly) {
      desired = current === 0n || desired * current <= 0n ? 0n : (abs(desired) > abs(current) ? current : desired);
      target.set(market, desired);
    }
    ensure(abs(desired) <= money(limit.maxAbsNotionalMicros), 'market exposure exceeds limit');
  }
  const gross = [...target.values()].reduce((sum, value) => sum + abs(value), 0n);
  const grossLimit = Math.floor(config.policy.maxGrossLeverage * WEIGHT_UNITS);
  ensure(Number.isSafeInteger(grossLimit) && gross * BigInt(WEIGHT_UNITS) <= equity * BigInt(grossLimit), 'gross exposure exceeds limit');
  const deltas: MirrorPlan['deltas'] = [];
  for (const market of [...new Set([...target.keys(), ...actual.keys()])].sort()) {
    const desired = target.get(market) ?? 0n;
    const current = actual.get(market) ?? 0n;
    const delta = desired - current;
    // A zero target is a close; its relative drift threshold is zero.
    if (abs(delta) < 10_000_000n || abs(delta) * 10n < abs(desired)) continue;
    const reducing = current !== 0n && delta * current < 0n && abs(delta) <= abs(current);
    deltas.push({market, notionalMicros: delta.toString(), reduceOnly: reducing || limits.get(market)!.reduceOnly});
  }
  ensure(deltas.length <= 10, 'order capacity exceeded');
  // Drift gates leave real exposure behind. Check reachable holdings, not only targets.
  const changes = new Map(deltas.map(delta => [delta.market, money(delta.notionalMicros)]));
  let projectedGross = 0n;
  let worstFillGross = 0n;
  for (const market of new Set([...target.keys(), ...actual.keys()])) {
    const current = actual.get(market) ?? 0n;
    const projected = current + (changes.get(market) ?? 0n);
    ensure(abs(projected) <= money(limits.get(market)!.maxAbsNotionalMicros), 'projected market exposure exceeds limit');
    projectedGross += abs(projected);
    // Absolute exposure is convex along an order's fill interval. Independent
    // endpoint maxima bound any ordering and any combination of partial fills.
    worstFillGross += abs(current) > abs(projected) ? abs(current) : abs(projected);
  }
  ensure(projectedGross * BigInt(WEIGHT_UNITS) <= equity * BigInt(grossLimit), 'projected gross exposure exceeds limit');
  ensure(worstFillGross * BigInt(WEIGHT_UNITS) <= equity * BigInt(grossLimit), 'partial-fill gross exposure exceeds limit');
  const oldest = Math.min(snapshot.publishedAtMs, input.account.observedAtMs, ...snapshot.sources.map(state => state.observedAtMs), ...input.checks.map(state => state.observedAtMs));
  const report = {
    mode: 'PAPER' as const, runId: input.runId, configurationHash: config.configurationHash,
    snapshotHash: snapshot.snapshotHash, accountHash: commitment('perpparrot:account:v1', input.account),
    validationHash: commitment('perpparrot:mirror-evidence:v1', {sample:[...input.sampledAddresses].sort(), checks:[...input.checks].sort((a,b)=>a.address<b.address?-1:a.address>b.address?1:0), markets:[...input.markets].sort((a,b)=>a.market<b.market?-1:a.market>b.market?1:0), maxStateAgeMs:ageMs}),
    asOfMs: nowMs, expiresAtMs: oldest + ageMs,
    targets: [...target].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([market, amount]) => ({market, notionalMicros: amount.toString()})),
    deltas, grossNotionalMicros: gross.toString(),
    projectedGrossNotionalMicros: projectedGross.toString(), worstFillGrossNotionalMicros: worstFillGross.toString(),
  };
  ensure(report.expiresAtMs > nowMs && Number.isSafeInteger(report.expiresAtMs), 'state expired at plan issuance');
  return {...report, planHash: commitment('perpparrot:mirror-plan:v1', report)};
}

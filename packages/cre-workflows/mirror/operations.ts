import {commitment} from '../../shared/src/commitments.ts';
import {validateFrozenConfiguration} from '../../shared/src/frozen-runtime.ts';
import type {FrozenConfiguration} from '../../shared/src/frozen-runtime.ts';

/** Seed must come from agreed trusted orchestration. This does not generate randomness.
 * Avoid node-local Math.random() and avoid treating a backend-selected seed as trusted.
 */
export function selectSpotChecks(configuration: FrozenConfiguration, seed: string): string[] {
  validateFrozenConfiguration(configuration);
  if (!/^0x[0-9a-f]{64}$/.test(seed)) throw new Error('invalid agreed sampling seed');
  return configuration.sources.map(source => ({
    address:source.sourceAddress,
    rank:commitment('perpparrot:sample:v1', {seed, configurationHash:configuration.configurationHash, address:source.sourceAddress}),
  })).sort((a, b) => a.rank < b.rank ? -1 : a.rank > b.rank ? 1 : a.address < b.address ? -1 : 1)
    .slice(0,10).map(source => source.address);
}

export interface FailureState {
  lastSlot: number;
  consecutiveFailures: number;
  /** Persist this outbox ID atomically with the failure count. */
  alertId: string | null;
}
export interface FailureTransition {
  state: FailureState;
  changed: boolean;
  enqueueAlert: boolean;
}
/** Pure transition; durable CAS and idempotent alert delivery are adapter obligations.
 * A slot is the scheduled 10-minute epoch slot, not completion wall time.
 * Duplicate, late and out-of-order runs cannot increment failures or reset newer state.
 */
export function recordMirrorOutcome(previous: FailureState, slot: number, success: boolean, workflowId: string): FailureTransition {
  if (!Number.isSafeInteger(slot) || slot < 0 || !Number.isSafeInteger(previous.lastSlot) || previous.lastSlot < -1 || !Number.isSafeInteger(previous.consecutiveFailures) || previous.consecutiveFailures < 0 || previous.consecutiveFailures > Number.MAX_SAFE_INTEGER - 1 || typeof success !== 'boolean' || !/^[A-Za-z0-9:_-]{1,100}$/.test(workflowId) || (previous.alertId !== null && !/^0x[0-9a-f]{64}$/.test(previous.alertId))) throw new Error('invalid failure state/event');
  if (slot <= previous.lastSlot) return {state:{...previous}, changed:false, enqueueAlert:false};
  // A missing slot breaks a recorded consecutive streak. A separate watchdog must
  // record missed executions as failures; absence is not silently called a success.
  const consecutiveFailures = success ? 0 : (slot === previous.lastSlot + 1 ? previous.consecutiveFailures + 1 : 1);
  const enqueueAlert = consecutiveFailures === 2;
  const alertId = success ? null : enqueueAlert
    ? commitment('perpparrot:failure-alert:v1', {workflowId, slot})
    : consecutiveFailures > 2 ? previous.alertId : null;
  return {state:{lastSlot:slot, consecutiveFailures, alertId}, changed:true, enqueueAlert};
}

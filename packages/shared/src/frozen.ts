import type {Manifest, Policy, Source} from './contracts.ts';
import {commitment, policyCommitment} from './commitments.ts';
import {validateManifest} from './authorization.ts';
import {validate} from './validate.ts';

export const WEIGHT_UNITS = 1_000_000;
export interface FrozenSource extends Omit<Source, 'weight' | 'maxAllocation'> {
  weightUnits: number;
  ceilingUnits: number;
}
/** Long-lived allocation configuration. It contains no fresh account or price authority. */
export interface FrozenConfiguration {
  schemaVersion: '1.0.0';
  account: string;
  chainId: number;
  frozenAtMs: number;
  reviewHash: string;
  policy: Policy;
  policyHash: string;
  sources: FrozenSource[];
  cashUnits: number;
  configurationHash: string;
}
/** Trusted adapter output, not fields supplied by the snapshot API or model.
 * The chain adapter must verify the consumer, workflow identity and confirmed state.
 */
export interface ConfirmedFreeze {
  configurationHash: string;
  account: string;
  chainId: number;
  active: boolean;
}
const address = /^0x[0-9a-f]{40}$/;
const hash = /^0x[0-9a-f]{64}$/;
function requireCondition(ok: boolean, reason: string): asserts ok {
  if (!ok) throw new Error(reason);
}
function exactKeys(value: object, keys: string[]): void {
  requireCondition(Object.keys(value).sort().join(',') === keys.sort().join(','), 'unknown or missing configuration fields');
}

/** Creates a proposal only; does not write a contract or activate execution. */
export function proposeFreeze(manifest: Manifest, account: string, chainId: number, nowMs: number): FrozenConfiguration {
  validateManifest(manifest, nowMs);
  requireCondition(manifest.status === 'VALID' && manifest.mode === 'LIVE', 'only a valid live review can propose freeze');
  const sources = manifest.sources.map(source => ({
    candidate: source.candidate,
    sourceAddress: source.sourceAddress,
    weightUnits: Math.floor(source.weight * WEIGHT_UNITS),
    ceilingUnits: Math.floor(source.maxAllocation * WEIGHT_UNITS),
  })).sort((a, b) => a.candidate - b.candidate);
  const payload = {
    schemaVersion: '1.0.0' as const, account, chainId, frozenAtMs: nowMs,
    reviewHash: manifest.manifestHash, policy: structuredClone(manifest.policy),
    policyHash: manifest.policyHash, sources,
    cashUnits: WEIGHT_UNITS - sources.reduce((sum, source) => sum + source.weightUnits, 0),
  };
  const configuration = {...payload, configurationHash: commitment('perpparrot:frozen:v1', payload)};
  validateFrozenConfiguration(configuration);
  return configuration;
}

export function validateFrozenConfiguration(value: FrozenConfiguration): void {
  requireCondition(value !== null && typeof value === 'object', 'invalid frozen configuration');
  exactKeys(value, ['schemaVersion','account','chainId','frozenAtMs','reviewHash','policy','policyHash','sources','cashUnits','configurationHash']);
  requireCondition(value.schemaVersion === '1.0.0' && address.test(value.account), 'invalid frozen identity');
  requireCondition(Number.isSafeInteger(value.chainId) && value.chainId > 0 && Number.isSafeInteger(value.frozenAtMs) && value.frozenAtMs >= 0, 'invalid frozen time/chain');
  requireCondition(hash.test(value.reviewHash) && hash.test(value.configurationHash), 'invalid frozen commitment');
  validate('bucket-policy', value.policy);
  requireCondition(value.policy.mode === 'LIVE' && value.policy.bucket === 'BALANCED', 'unsupported live policy');
  requireCondition(value.policyHash === policyCommitment(value.policy), 'frozen policy mismatch');
  requireCondition(Array.isArray(value.sources) && value.sources.length >= 5 && value.sources.length <= 25, 'freeze requires 5–25 sources');
  requireCondition(Number.isSafeInteger(value.cashUnits) && value.cashUnits >= Math.ceil(value.policy.cashBuffer * WEIGHT_UNITS), 'invalid frozen cash buffer');
  let previousCandidate = -1;
  const addresses = new Set<string>();
  for (const source of value.sources) {
    exactKeys(source, ['candidate','sourceAddress','weightUnits','ceilingUnits']);
    requireCondition(Number.isSafeInteger(source.candidate) && source.candidate > previousCandidate && address.test(source.sourceAddress) && source.sourceAddress !== value.account && !addresses.has(source.sourceAddress), 'invalid frozen source identity/order');
    requireCondition(Number.isSafeInteger(source.weightUnits) && Number.isSafeInteger(source.ceilingUnits) && source.weightUnits > 0 && source.weightUnits <= source.ceilingUnits && source.ceilingUnits <= Math.floor(value.policy.maxSourceWeight * WEIGHT_UNITS), 'invalid frozen weight');
    previousCandidate = source.candidate;
    addresses.add(source.sourceAddress);
  }
  requireCondition(value.cashUnits + value.sources.reduce((sum, source) => sum + source.weightUnits, 0) === WEIGHT_UNITS, 'invalid frozen total');
  const {configurationHash, ...payload} = value;
  requireCondition(configurationHash === commitment('perpparrot:frozen:v1', payload), 'frozen commitment mismatch');
}

/** Does not reuse the expired review frame. Freshness belongs to each mirror snapshot. */
export function requireConfirmedFreeze(configuration: FrozenConfiguration, trusted: ConfirmedFreeze, nowMs: number): void {
  validateFrozenConfiguration(configuration);
  requireCondition(Number.isSafeInteger(nowMs) && nowMs >= configuration.frozenAtMs, 'future frozen configuration');
  requireCondition(trusted.active === true && trusted.configurationHash === configuration.configurationHash && trusted.account === configuration.account && trusted.chainId === configuration.chainId, 'freeze is not confirmed active authority');
}

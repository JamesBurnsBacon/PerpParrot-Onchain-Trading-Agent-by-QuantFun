import type {Manifest} from './contracts.ts';
import {validateManifest} from './authorization.ts';
import {commitment} from './commitments.ts';
import {WEIGHT_UNITS,validateFrozenConfiguration} from './frozen-runtime.ts';
import type {FrozenConfiguration} from './frozen-runtime.ts';
export * from './frozen-runtime.ts';

/** Creates a proposal only; does not write a contract or activate execution. */
export function proposeFreeze(manifest: Manifest, account: string, chainId: number, nowMs: number): FrozenConfiguration {
  validateManifest(manifest, nowMs);
  if(manifest.status !== 'VALID' || manifest.mode !== 'LIVE')throw new Error('only a valid live review can propose freeze');
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

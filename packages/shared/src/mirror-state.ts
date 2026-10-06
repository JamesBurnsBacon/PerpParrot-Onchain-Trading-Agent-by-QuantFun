import type {ConfirmedFreeze,FrozenConfiguration} from './frozen-runtime.ts';
import type {MirrorPlan,Position} from './mirror-plan.ts';
import {commitment} from './commitments.ts';
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

export function snapshotHash(snapshot:Omit<PositionsSnapshot,'snapshotHash'>):string {return commitment('perpparrot:positions:v1',snapshot);}

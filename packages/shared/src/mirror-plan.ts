/** Canonical paper plan contract shared by orchestration and paper consumers. */
export interface Position {market: string; notionalMicros: string}
export interface MirrorPlan {
  mode: 'PAPER';
  runId: string;
  configurationHash: string;
  snapshotHash: string;
  accountHash: string;
  validationHash: string;
  asOfMs: number;
  expiresAtMs: number;
  targets: Position[];
  deltas: (Position & {reduceOnly: boolean})[];
  grossNotionalMicros: string;
  projectedGrossNotionalMicros: string;
  worstFillGrossNotionalMicros: string;
  planHash: string;
}

export type Bucket = 'CONSERVATIVE' | 'BALANCED' | 'AGGRESSIVE';
export type Mode = 'LIVE' | 'SIMULATION';
export interface Binding { schemaVersion: '1.0.0'; snapshotHash: string; policyHash: string }
export interface Candidate {
  candidate: number;
  kind: 'TRADER' | 'HYPERCORE_VAULT' | 'ERC4626_HYPERCORE';
  metrics: {
    historyDays: number; oosWindows: number; oosSharpe: number | null;
    oosSortino: number | null; oosMaxDrawdown: number | null;
    crossWindowStability: number | null; survivorshipQuality: string;
    medianHoldMinutes: number | null; averageLeverage: number | null;
    maxDrawdown: number; timeInMarket: number; makerShare: number | null;
    executionCoverage: number; executionFit: number; concentration: number;
    liquidationDistance: number | null; btcBeta: number | null; pnlConsistency: number;
  };
}
export interface Frame extends Binding {
  asOfMs: number; expiresAtMs: number; candidates: Candidate[];
  pairs: {a: number; b: number; correlation: number | null; currentExposureOverlap: number; linkedSource: boolean}[];
}
export interface Policy {
  bucket: Bucket; mode: Mode; capitalUsd: number; minOrderUsd: 10;
  minExecutableTargets: number; maxSourceWeight: number; maxGrossLeverage: number;
  cashBuffer: number; maxPairCorrelation: number; maxExposureOverlap: number;
  minHistoryDays: number; maxFrameAgeMs: number; minExecutionFit: number;
  riskRejectThreshold: number; riskWatchThreshold: number; minConfidence: number;
  redTeamRebuildThreshold: number; redTeamExcludeThreshold: number;
}
export type Row = {candidate: number} & Record<string, number>;
export interface Observation extends Binding {
  promptHash: string; modelConfigHash: string; results: Row[];
}
export interface Critique extends Binding {
  promptHash: string; modelConfigHash: string; draftHash: string;
  rebuildScore: number; portfolioRisk: number;
  penalties: {candidate: number; multiplier: number; excludeScore: number}[];
}
export interface Source {candidate: number; sourceAddress: string; weight: number; maxAllocation: number}
export interface Manifest extends Binding {
  manifestHash: string; createdAtMs: number; expiresAtMs: number;
  bucket: Bucket; mode: Mode; status: 'VALID' | 'INVALID_BUCKET'; rebuildCount: 0 | 1;
  policy: Policy; sources: Source[]; cashWeight: number;
  reason: 'OK' | 'AGENT_FAILURE' | 'STALE_INPUT' | 'INSUFFICIENT_EVIDENCE' | 'CAPACITY' | 'POLICY_VIOLATION';
}
export type SchemaName = 'candidate-curation-frame' | 'bucket-policy' | 'role-consensus' | 'risk-consensus' | 'redteam-consensus' | 'bucket-manifest' | 'rebalance-report';

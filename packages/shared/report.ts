// Mirror → executor report body (README §4.13). ABI-encoded after the 109-byte
// CRE report header. No imports, so both the CRE workflow and the executor can
// use it with their own copy of viem.
export const REPORT_BODY_ABI =
  "string runId, bytes32 snapshotHash, bytes32 configurationHash, address account, uint64 asOf, uint64 expiresAt, int256 equityE6, (string asset, int256 notionalE6)[] targets";

export type Target = {
  asset: string;
  // Signed USD notional × 1e6 (negative = short).
  notionalE6: bigint;
};

export type MirrorReport = {
  runId: string;
  // keccak256 of the snapshot JSON the DON agreed on.
  snapshotHash: `0x${string}`;
  // The frozen configuration that authorizes these targets.
  configurationHash: `0x${string}`;
  // Our HL account the targets are for.
  account: `0x${string}`;
  // Unix seconds of the scheduled mirror run, and when the report stops being valid.
  asOf: bigint;
  expiresAt: bigint;
  equityE6: bigint;
  targets: Target[];
};

// JSON body POSTed by each DON node (hex without 0x, per the CRE offchain verification guide).
export type ReportEnvelope = {
  report: string;
  context: string;
  signatures: string[];
};

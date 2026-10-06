import { concatHex, decodeAbiParameters, keccak256, parseAbiParameters, toHex, type Hex } from "viem";
import { REPORT_BODY_ABI, type MirrorReport } from "../../shared/report";

// CRE report metadata header (CRE "Verifying Reports Offchain" guide).
export const REPORT_HEADER_LENGTH = 109;

export type ReportHeader = {
  donId: number;
  workflowId: Hex;
  workflowOwner: Hex;
  body: Uint8Array;
};

export const parseHeader = (rawReport: Uint8Array): ReportHeader => {
  if (rawReport.length < REPORT_HEADER_LENGTH) {
    throw new Error(`rawReport too short: need ${REPORT_HEADER_LENGTH} bytes, got ${rawReport.length}`);
  }
  const view = new DataView(rawReport.buffer, rawReport.byteOffset);
  return {
    donId: view.getUint32(37, false),
    workflowId: toHex(rawReport.slice(45, 77)),
    workflowOwner: toHex(rawReport.slice(87, 107)),
    body: rawReport.slice(REPORT_HEADER_LENGTH),
  };
};

// What the DON signs: keccak256(keccak256(rawReport) || reportContext).
export const signedHash = (rawReport: Uint8Array, reportContext: Uint8Array): Hex =>
  keccak256(concatHex([keccak256(toHex(rawReport)), toHex(reportContext)]));

// Identical across nodes (only signatures differ), so it's the dedupe key.
export const reportId = (rawReport: Uint8Array): Hex => keccak256(rawReport);

const bodyParams = parseAbiParameters(REPORT_BODY_ABI);

export const decodeBody = (body: Uint8Array): MirrorReport => {
  const [runId, snapshotHash, configurationHash, account, asOf, expiresAt, equityE6, targets] = decodeAbiParameters(
    bodyParams,
    toHex(body),
  );
  return { runId, snapshotHash, configurationHash, account, asOf, expiresAt, equityE6, targets: [...targets] };
};

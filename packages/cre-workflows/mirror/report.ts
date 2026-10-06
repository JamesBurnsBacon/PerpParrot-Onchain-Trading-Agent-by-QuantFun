import { bytesToHex, encodeAbiParameters, parseAbiParameters, type Hex } from "viem";
import { REPORT_BODY_ABI, type MirrorReport, type ReportEnvelope } from "../../shared/report";

const bodyParams = parseAbiParameters(REPORT_BODY_ABI);

export const encodeReportBody = (r: MirrorReport): Hex =>
  encodeAbiParameters(bodyParams, [
    r.runId,
    r.snapshotHash,
    r.configurationHash,
    r.account,
    r.asOf,
    r.expiresAt,
    r.exposures,
  ]);

type SignedReport = {
  rawReport: Uint8Array;
  reportContext: Uint8Array;
  sigs: { signature: Uint8Array }[];
};

const hexNo0x = (b: Uint8Array) => bytesToHex(b).slice(2);

export const toEnvelope = (r: SignedReport): ReportEnvelope => ({
  report: hexNo0x(r.rawReport),
  context: hexNo0x(r.reportContext),
  signatures: r.sigs.map((s) => hexNo0x(s.signature)),
});

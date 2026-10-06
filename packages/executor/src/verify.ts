import { hexToBytes, recoverAddress, toHex, type Hex } from "viem";
import type { MirrorReport, ReportEnvelope } from "../../shared/report";
import { decodeBody, parseHeader, reportId, signedHash } from "./report";
import type { SignerSource } from "./signers";

export type VerifyMode =
  // Production: ≥ f+1 registry signers and the pinned workflow owner.
  | { kind: "registry"; signers: SignerSource; workflowOwner: Hex }
  // `cre workflow simulate` signs with throwaway keys that aren't in the registry,
  // so only check that the signatures recover. Never allowed in production.
  | { kind: "simulation" };

export type VerifiedReport = {
  id: Hex;
  donId: number;
  workflowOwner: Hex;
  signers: string[];
  body: MirrorReport;
};

const fromHex = (field: string, value: unknown): Uint8Array => {
  if (typeof value !== "string" || !/^[0-9a-fA-F]*$/.test(value)) {
    throw new Error(`${field} must be hex without 0x`);
  }
  return hexToBytes(`0x${value}`);
};

const recover = async (hash: Hex, sig: Uint8Array): Promise<string | undefined> => {
  if (sig.length !== 65) return undefined;
  const normalized = new Uint8Array(sig);
  if (normalized[64] >= 27) normalized[64] -= 27;
  try {
    return (await recoverAddress({ hash, signature: toHex(normalized) })).toLowerCase();
  } catch {
    return undefined;
  }
};

export const verifyEnvelope = async (envelope: ReportEnvelope, mode: VerifyMode): Promise<VerifiedReport> => {
  const rawReport = fromHex("report", envelope.report);
  const context = fromHex("context", envelope.context);
  if (!Array.isArray(envelope.signatures)) throw new Error("signatures must be an array");
  const sigs = envelope.signatures.map((s, i) => fromHex(`signatures[${i}]`, s));

  const header = parseHeader(rawReport);
  const hash = signedHash(rawReport, context);
  const recovered = new Set<string>();
  for (const sig of sigs) {
    const addr = await recover(hash, sig);
    if (addr) recovered.add(addr);
  }

  if (mode.kind === "registry") {
    if (header.workflowOwner.toLowerCase() !== mode.workflowOwner.toLowerCase()) {
      throw new Error(`unexpected workflow owner ${header.workflowOwner}`);
    }
    const { f, signers } = await mode.signers(header.donId);
    const valid = [...recovered].filter((a) => signers.has(a)).length;
    if (valid < f + 1) throw new Error(`insufficient valid signatures: ${valid}/${f + 1}`);
  } else if (recovered.size === 0) {
    throw new Error("no recoverable signatures");
  }

  return {
    id: reportId(rawReport),
    donId: header.donId,
    workflowOwner: header.workflowOwner,
    signers: [...recovered],
    body: decodeBody(header.body),
  };
};

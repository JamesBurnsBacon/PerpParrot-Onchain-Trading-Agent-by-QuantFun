import { bytesToHex, concatBytes, encodeAbiParameters, hexToBytes, parseAbiParameters, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount, sign } from "viem/accounts";
import { REPORT_BODY_ABI, type MirrorReport, type ReportEnvelope } from "../../shared/report";
import { REPORT_HEADER_LENGTH, signedHash } from "../src/report";
import type { DonSigners } from "../src/signers";
import type { VerifyMode } from "../src/verify";

export const OWNER = "0x1111111111111111111111111111111111111111" as Hex;
export const MANIFEST = `0x${"ab".repeat(32)}` as Hex;
export const ACCOUNT = "0x2222222222222222222222222222222222222222" as Hex;
export const DON_ID = 7;
export const AS_OF = 1_791_264_000;

export const body = (overrides: Partial<MirrorReport> = {}): MirrorReport => ({
  runId: `mirror-${AS_OF}`,
  snapshotHash: `0x${"cd".repeat(32)}`,
  manifestHash: MANIFEST,
  account: ACCOUNT,
  asOf: BigInt(AS_OF),
  expiresAt: BigInt(AS_OF + 300),
  equityE6: 470_000_000n,
  targets: [
    { asset: "BTC", notionalE6: 1_200_000_000n },
    { asset: "ETH", notionalE6: -350_000_000n },
  ],
  ...overrides,
});

// A rawReport with the 109-byte CRE header layout followed by the ABI body.
export const buildRawReport = (b: MirrorReport, owner: Hex = OWNER): Uint8Array => {
  const header = new Uint8Array(REPORT_HEADER_LENGTH);
  new DataView(header.buffer).setUint32(37, DON_ID, false);
  header.set(hexToBytes(`0x${"cd".repeat(32)}`), 45);
  header.set(hexToBytes(owner), 87);
  const encoded = encodeAbiParameters(parseAbiParameters(REPORT_BODY_ABI), [
    b.runId,
    b.snapshotHash,
    b.manifestHash,
    b.account,
    b.asOf,
    b.expiresAt,
    b.equityE6,
    b.targets,
  ]);
  return concatBytes([header, hexToBytes(encoded)]);
};

export const keys = [generatePrivateKey(), generatePrivateKey(), generatePrivateKey(), generatePrivateKey()];
const context = hexToBytes(`0x${"0e".repeat(96)}`);

export const envelope = async (
  signWith: Hex[],
  opts: { owner?: Hex; body?: MirrorReport } = {},
): Promise<ReportEnvelope> => {
  const raw = buildRawReport(opts.body ?? body(), opts.owner);
  const hash = signedHash(raw, context);
  const sigs = await Promise.all(signWith.map((privateKey) => sign({ hash, privateKey, to: "hex" })));
  return {
    report: bytesToHex(raw).slice(2),
    context: bytesToHex(context).slice(2),
    signatures: sigs.map((s) => s.slice(2)),
  };
};

// f = 1 → 2 valid signatures required.
export const don: DonSigners = { f: 1, signers: new Set(keys.map((k) => privateKeyToAccount(k).address.toLowerCase())) };
export const registry: VerifyMode = { kind: "registry", signers: async () => don, workflowOwner: OWNER };

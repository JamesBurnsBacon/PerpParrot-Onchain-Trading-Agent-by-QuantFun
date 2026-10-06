import { describe, expect, test } from "bun:test";
import { bytesToHex, concatBytes, encodeAbiParameters, hexToBytes, parseAbiParameters, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount, sign } from "viem/accounts";
import { REPORT_BODY_ABI, type MirrorReport, type ReportEnvelope } from "../../shared/report";
import { handleReport, type HandlerDeps } from "../src/handler";
import { REPORT_HEADER_LENGTH, signedHash } from "../src/report";
import type { DonSigners } from "../src/signers";
import { verifyEnvelope, type VerifyMode } from "../src/verify";

const OWNER = "0x1111111111111111111111111111111111111111" as Hex;
const FROZEN = `0x${"ab".repeat(32)}` as Hex;
const DON_ID = 7;

const body: MirrorReport = {
  runId: "mirror-1791264000",
  snapshotId: "snap-1",
  asOf: 1_791_264_000n,
  frozenSetHash: FROZEN,
  equityE6: 470_000_000n,
  targets: [
    { asset: "BTC", notionalE6: 1_200_000_000n },
    { asset: "ETH", notionalE6: -350_000_000n },
  ],
};

// Builds a rawReport with the 109-byte CRE header layout followed by the ABI body.
const buildRawReport = (owner: Hex): Uint8Array => {
  const header = new Uint8Array(REPORT_HEADER_LENGTH);
  new DataView(header.buffer).setUint32(37, DON_ID, false);
  header.set(hexToBytes(`0x${"cd".repeat(32)}`), 45);
  header.set(hexToBytes(owner), 87);
  const encoded = encodeAbiParameters(parseAbiParameters(REPORT_BODY_ABI), [
    body.runId, body.snapshotId, body.asOf, body.frozenSetHash, body.equityE6, body.targets,
  ]);
  return concatBytes([header, hexToBytes(encoded)]);
};

const keys = [generatePrivateKey(), generatePrivateKey(), generatePrivateKey(), generatePrivateKey()];
const addresses = keys.map((k) => privateKeyToAccount(k).address.toLowerCase());
const context = hexToBytes(`0x${"0e".repeat(96)}`);

const envelope = async (signWith: Hex[], owner: Hex = OWNER): Promise<ReportEnvelope> => {
  const raw = buildRawReport(owner);
  const hash = signedHash(raw, context);
  const sigs = await Promise.all(signWith.map((privateKey) => sign({ hash, privateKey, to: "hex" })));
  return {
    report: bytesToHex(raw).slice(2),
    context: bytesToHex(context).slice(2),
    signatures: sigs.map((s) => s.slice(2)),
  };
};

// f = 1 → 2 valid signatures required.
const don: DonSigners = { f: 1, signers: new Set(addresses) };
const registry: VerifyMode = { kind: "registry", signers: async () => don, workflowOwner: OWNER };

describe("verifyEnvelope (registry)", () => {
  test("accepts f+1 registry signatures and decodes the body", async () => {
    const r = await verifyEnvelope(await envelope(keys.slice(0, 2)), registry);
    expect(r.donId).toBe(DON_ID);
    expect(r.body.runId).toBe(body.runId);
    expect(r.body.targets).toEqual(body.targets);
    expect(r.signers).toHaveLength(2);
  });

  test("rejects too few registry signatures", async () => {
    await expect(verifyEnvelope(await envelope(keys.slice(0, 1)), registry)).rejects.toThrow("insufficient valid signatures: 1/2");
  });

  test("doesn't count signatures from unknown signers", async () => {
    await expect(verifyEnvelope(await envelope([keys[0], generatePrivateKey()]), registry)).rejects.toThrow("insufficient");
  });

  test("doesn't count the same signer twice", async () => {
    await expect(verifyEnvelope(await envelope([keys[0], keys[0]]), registry)).rejects.toThrow("insufficient");
  });

  test("rejects a different workflow owner", async () => {
    const other = "0x2222222222222222222222222222222222222222" as Hex;
    await expect(verifyEnvelope(await envelope(keys.slice(0, 2), other), registry)).rejects.toThrow("unexpected workflow owner");
  });

  test("rejects a tampered body", async () => {
    const env = await envelope(keys.slice(0, 2));
    const tampered = { ...env, report: env.report.slice(0, -2) + (env.report.endsWith("00") ? "01" : "00") };
    await expect(verifyEnvelope(tampered, registry)).rejects.toThrow("insufficient");
  });

  test("rejects malformed hex", async () => {
    await expect(verifyEnvelope({ report: "0xzz", context: "", signatures: [] }, registry)).rejects.toThrow("hex without 0x");
  });
});

describe("verifyEnvelope (simulation)", () => {
  test("accepts any recoverable signature and ignores the owner", async () => {
    const r = await verifyEnvelope(await envelope([generatePrivateKey()], "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"), {
      kind: "simulation",
    });
    expect(r.body.snapshotId).toBe("snap-1");
  });
});

describe("handleReport", () => {
  const deps = (overrides: Partial<HandlerDeps> = {}): HandlerDeps => {
    const claimed = new Set<string>();
    return {
      mode: registry,
      frozenSetHash: FROZEN,
      maxAgeSeconds: 300,
      now: () => Number(body.asOf) + 10,
      claim: async (id) => !claimed.has(id) && Boolean(claimed.add(id)),
      execute: async () => {},
      ...overrides,
    };
  };

  test("executes the first copy and acks later copies as duplicates", async () => {
    const d = deps();
    let executed = 0;
    d.execute = async () => void executed++;
    // Each node signs with its own key set, so the bodies differ but the report ID doesn't.
    const first = await handleReport(await envelope([keys[0], keys[1]]), d);
    const second = await handleReport(await envelope([keys[2], keys[3]]), d);
    expect(first).toMatchObject({ status: 200, body: { status: "executed" } });
    expect(second).toMatchObject({ status: 200, body: { status: "duplicate", id: first.body.id } });
    expect(executed).toBe(1);
  });

  test("rejects unverifiable reports with 401", async () => {
    expect((await handleReport(await envelope([keys[0]]), deps())).status).toBe(401);
  });

  test("rejects stale reports", async () => {
    const r = await handleReport(await envelope(keys.slice(0, 2)), deps({ now: () => Number(body.asOf) + 301 }));
    expect(r).toMatchObject({ status: 422, body: { error: "stale report (301s old)" } });
  });

  test("rejects a different frozen set", async () => {
    const r = await handleReport(await envelope(keys.slice(0, 2)), deps({ frozenSetHash: `0x${"00".repeat(32)}` }));
    expect(r).toMatchObject({ status: 422, body: { error: "frozen set mismatch" } });
  });
});

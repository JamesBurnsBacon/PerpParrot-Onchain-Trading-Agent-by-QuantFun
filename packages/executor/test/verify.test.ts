import { describe, expect, test } from "bun:test";
import type { Hex } from "viem";
import { generatePrivateKey } from "viem/accounts";
import { handleReport, type HandlerDeps } from "../src/handler";
import { verifyEnvelope } from "../src/verify";
import { ACCOUNT, AS_OF, body, DON_ID, envelope, keys, MANIFEST, registry } from "./helpers";

describe("verifyEnvelope (registry)", () => {
  test("accepts f+1 registry signatures and decodes the body", async () => {
    const r = await verifyEnvelope(await envelope(keys.slice(0, 2)), registry);
    expect(r.donId).toBe(DON_ID);
    expect(r.body).toEqual(body());
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
    const other = "0x3333333333333333333333333333333333333333" as Hex;
    await expect(verifyEnvelope(await envelope(keys.slice(0, 2), { owner: other }), registry)).rejects.toThrow(
      "unexpected workflow owner",
    );
  });

  test("rejects a tampered body", async () => {
    const env = await envelope(keys.slice(0, 2));
    const tampered = { ...env, report: env.report.slice(0, -2) + (env.report.endsWith("00") ? "01" : "00") };
    await expect(verifyEnvelope(tampered, registry)).rejects.toThrow("insufficient");
  });

  test("rejects malformed hex", async () => {
    await expect(verifyEnvelope({ report: "0xzz", context: "", signatures: [] }, registry)).rejects.toThrow("hex without 0x");
  });

  test("rejects a missing signatures array", async () => {
    const env = await envelope(keys.slice(0, 2));
    await expect(verifyEnvelope({ ...env, signatures: undefined as unknown as string[] }, registry)).rejects.toThrow(
      "signatures must be an array",
    );
  });
});

describe("verifyEnvelope (simulation)", () => {
  test("accepts any recoverable signature and ignores the owner", async () => {
    const r = await verifyEnvelope(await envelope([generatePrivateKey()], { owner: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" }), {
      kind: "simulation",
    });
    expect(r.body.runId).toBe(`mirror-${AS_OF}`);
  });

  test("still requires at least one recoverable signature", async () => {
    const env = await envelope([]);
    await expect(verifyEnvelope(env, { kind: "simulation" })).rejects.toThrow("no recoverable signatures");
  });
});

describe("handleReport", () => {
  const deps = (overrides: Partial<HandlerDeps> = {}) => {
    const claimed = new Set<string>();
    const accepted: string[] = [];
    const d: HandlerDeps = {
      mode: registry,
      frozenManifestHash: MANIFEST,
      account: ACCOUNT,
      now: () => AS_OF + 10,
      maxLeadSeconds: 60,
      claim: async (id) => !claimed.has(id) && Boolean(claimed.add(id)),
      accept: (r) => void accepted.push(r.body.runId),
      ...overrides,
    };
    return { d, accepted };
  };

  test("accepts the first copy and acks later copies as duplicates", async () => {
    const { d, accepted } = deps();
    // Each node signs with its own key set, so the bodies differ but the report ID doesn't.
    const first = await handleReport(await envelope([keys[0], keys[1]]), d);
    const second = await handleReport(await envelope([keys[2], keys[3]]), d);
    expect(first).toMatchObject({ status: 200, body: { status: "accepted" } });
    expect(second).toMatchObject({ status: 200, body: { status: "duplicate", id: first.body.id } });
    expect(accepted).toEqual([`mirror-${AS_OF}`]);
  });

  test("rejects unverifiable reports with 401", async () => {
    expect((await handleReport(await envelope([keys[0]]), deps().d)).status).toBe(401);
  });

  test("rejects expired reports", async () => {
    const r = await handleReport(await envelope(keys.slice(0, 2)), deps({ now: () => AS_OF + 301 }).d);
    expect(r).toMatchObject({ status: 422, body: { error: "expired report (1s past expiry)" } });
  });

  test("rejects reports from the future", async () => {
    const r = await handleReport(await envelope(keys.slice(0, 2)), deps({ now: () => AS_OF - 61 }).d);
    expect(r).toMatchObject({ status: 422, body: { error: "report from the future" } });
  });

  test("rejects a different manifest", async () => {
    const r = await handleReport(await envelope(keys.slice(0, 2)), deps({ frozenManifestHash: `0x${"00".repeat(32)}` }).d);
    expect(r).toMatchObject({ status: 422, body: { error: "manifest mismatch" } });
  });

  test("rejects reports for another account", async () => {
    const r = await handleReport(await envelope(keys.slice(0, 2)), deps({ account: "0x4444444444444444444444444444444444444444" }).d);
    expect(r).toMatchObject({ status: 422, body: { error: "account mismatch" } });
  });

  test("doesn't claim rejected reports, so a valid copy can still be accepted", async () => {
    const { d, accepted } = deps();
    await handleReport(await envelope([keys[0]]), d);
    expect((await handleReport(await envelope(keys.slice(0, 2)), d)).body.status).toBe("accepted");
    expect(accepted).toHaveLength(1);
  });
});

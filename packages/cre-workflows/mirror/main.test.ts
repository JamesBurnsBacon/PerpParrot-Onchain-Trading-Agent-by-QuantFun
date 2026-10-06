import { describe, expect, test } from "bun:test";
import { decodeAbiParameters, hexToBytes, parseAbiParameters } from "viem";
import manifestFixture from "../../backend/fixtures/manifest.json";
import type { Manifest } from "../../shared/manifest";
import { REPORT_BODY_ABI } from "../../shared/report";
import type { PositionsSnapshot } from "../../shared/snapshot";
import staging from "./config.staging.json";
import { buildMirrorReport, initWorkflow, type Config } from "./main";
import { encodeReportBody, toEnvelope } from "./report";
import { checkSnapshot, pickSample } from "./snapshot";

const config = staging as Config;
const manifest = manifestFixture as Manifest;
const RUN_AT = 1_791_281_400;

const snapshot = (overrides: Partial<PositionsSnapshot> = {}): PositionsSnapshot => ({
  snapshotId: `snap-${RUN_AT}`,
  runAt: RUN_AT,
  takenAt: RUN_AT - 60,
  manifest,
  eligibleAssets: ["BTC", "ETH"],
  sources: manifest.sources
    .map((s) => s.sourceAddress)
    .sort()
    .map((address) => ({ address, equityE6: "1000000000", positions: [{ asset: "BTC", notionalE6: "500000000" }] })),
  ...overrides,
});

const limits = { frozenManifestHash: config.frozenManifestHash, runAt: RUN_AT, maxSnapshotAgeSeconds: 120 };

describe("config", () => {
  test("pins the fixture manifest", () => {
    expect(config.frozenManifestHash).toBe(manifest.manifestHash);
  });
});

describe("checkSnapshot", () => {
  test("accepts a snapshot for this run and attaches manifest weights", () => {
    const sources = checkSnapshot(snapshot(), limits);
    const byAddress = new Map(sources.map((s) => [s.address, s.weightE6]));
    expect(byAddress.get("0x1e37a337ed460039d1b15bd3bc489de789768d5e")).toBe(200_000);
    expect([...byAddress.values()].reduce((a, b) => a + b, 0)).toBe(800_000); // 20% cash
  });

  test("rejects another run's snapshot", () => {
    expect(() => checkSnapshot(snapshot({ runAt: 1 }), limits)).toThrow(`expected ${RUN_AT}`);
  });

  test("rejects a stale snapshot", () => {
    expect(() => checkSnapshot(snapshot({ takenAt: RUN_AT - 200 }), limits)).toThrow("200s before the run");
  });

  test("rejects a manifest that isn't the frozen one", () => {
    expect(() => checkSnapshot(snapshot(), { ...limits, frozenManifestHash: `0x${"00".repeat(32)}` })).toThrow(
      "not the frozen live authority",
    );
  });

  test("rejects a tampered manifest", () => {
    const tampered = { ...manifest, sources: manifest.sources.map((s, i) => (i === 0 ? { ...s, weight: 0.25 } : s)) };
    expect(() => checkSnapshot(snapshot({ manifest: tampered }), limits)).toThrow("manifest commitment mismatch");
  });

  test("checks the manifest's expiry against the run time", () => {
    const late = Math.floor(manifest.expiresAtMs / 1000) + 600;
    expect(() => checkSnapshot(snapshot({ runAt: late, takenAt: late }), { ...limits, runAt: late })).toThrow(
      "expired/future manifest",
    );
  });

  test("rejects sources that differ from the manifest", () => {
    const s = snapshot();
    s.sources[0] = { ...s.sources[0], address: "0x0000000000000000000000000000000000000001" };
    expect(() => checkSnapshot(s, limits)).toThrow("don't match the manifest");
    expect(() => checkSnapshot(snapshot({ sources: snapshot().sources.slice(1) }), limits)).toThrow("don't match the manifest");
  });

  test("rejects ineligible assets", () => {
    const s = snapshot();
    s.sources[0] = { ...s.sources[0], positions: [{ asset: "DOGE", notionalE6: "1" }] };
    expect(() => checkSnapshot(s, limits)).toThrow("ineligible asset in snapshot: DOGE");
  });
});

describe("pickSample", () => {
  test("is deterministic, distinct and capped", () => {
    const items = [...Array(25).keys()];
    const a = pickSample(items, "snap-1", 5);
    expect(a).toEqual(pickSample(items, "snap-1", 5));
    expect(new Set(a).size).toBe(5);
    expect(pickSample(items, "snap-2", 5)).not.toEqual(a);
    expect(pickSample([1, 2], "snap-1", 5)).toEqual([1, 2]);
  });
});

describe("buildMirrorReport", () => {
  test("sizes targets by our equity and round-trips through the shared ABI", () => {
    const report = buildMirrorReport(config, RUN_AT, {
      snapshotId: `snap-${RUN_AT}`,
      snapshotHash: `0x${"5e".repeat(32)}`,
      exposures: JSON.stringify([
        { asset: "BTC", exposureE9: "1250000000" },
        { asset: "ETH", exposureE9: "-500000000" },
      ]),
      maxDeviationBps: 3,
      equityE6: 470_000_000n,
    });
    const [runId, snapshotHash, manifestHash, account, asOf, expiresAt, equityE6, targets] = decodeAbiParameters(
      parseAbiParameters(REPORT_BODY_ABI),
      encodeReportBody(report),
    );
    expect(runId).toBe(`mirror-${RUN_AT}`);
    expect(snapshotHash).toBe(`0x${"5e".repeat(32)}`);
    expect(manifestHash).toBe(config.frozenManifestHash as `0x${string}`);
    expect(account.toLowerCase()).toBe(config.account);
    expect(asOf).toBe(BigInt(RUN_AT));
    expect(expiresAt).toBe(BigInt(RUN_AT + config.reportTtlSeconds));
    expect(equityE6).toBe(470_000_000n);
    expect(targets).toEqual([
      { asset: "BTC", notionalE6: 587_500_000n },
      { asset: "ETH", notionalE6: -235_000_000n },
    ]);
  });
});

describe("toEnvelope", () => {
  test("hex-encodes without 0x", () => {
    const env = toEnvelope({
      rawReport: hexToBytes("0x0102"),
      reportContext: hexToBytes("0x03"),
      sigs: [{ signature: hexToBytes("0xff") }],
    });
    expect(env).toEqual({ report: "0102", context: "03", signatures: ["ff"] });
  });
});

describe("initWorkflow", () => {
  test("registers one cron handler with the configured schedule", () => {
    const handlers = initWorkflow(config);
    expect(handlers).toHaveLength(1);
    expect(handlers[0].trigger.config.schedule).toBe("0 */10 * * * *");
  });
});

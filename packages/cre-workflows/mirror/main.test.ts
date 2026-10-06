import { describe, expect, test } from "bun:test";
import { decodeAbiParameters, hexToBytes, parseAbiParameters } from "viem";
import { REPORT_BODY_ABI } from "../../shared/report";
import type { PositionsSnapshot } from "../../shared/snapshot";
import { buildMirrorReport, initWorkflow, type Config } from "./main";
import { encodeReportBody, toEnvelope } from "./report";
import { checkSnapshot, frozenSetHash, pickSample } from "./snapshot";
import staging from "./config.staging.json";

const config = staging as Config;

const sources = [
  { address: "0x1e37a337ed460039d1b15bd3bc489de789768d5e", weightE6: 250000 },
  { address: "0xc179e03922afe8fa9533d3f896338b9fb87ce0c8", weightE6: 200000 },
  { address: "0x07fd993f0fa3a185f7207adccd29f7a87404689d", weightE6: 150000 },
  { address: "0x53f8f390fd4f70941c5d160a964f6893c8dbceff", weightE6: 150000 },
  { address: "0x654016a8c9fcf0c4cb7ed6078aba21f7f399f7b7", weightE6: 150000 },
  { address: "0xd6e56265890b76413d1d527eb9b75e334c0c5b42", weightE6: 100000 },
] as const;

const snapshot = (overrides: Partial<PositionsSnapshot> = {}): PositionsSnapshot => ({
  snapshotId: "snap-1791265800",
  runAt: 1_791_265_800,
  takenAt: 1_791_265_740,
  frozenSetHash: config.frozenSetHash as `0x${string}`,
  eligibleAssets: ["BTC", "ETH"],
  sources: sources.map((s) => ({ ...s, equityE6: "1000000000", positions: [{ asset: "BTC", notionalE6: "500000000" }] })),
  ...overrides,
});

const limits = { frozenSetHash: config.frozenSetHash, runAt: 1_791_265_800, maxSnapshotAgeSeconds: 120 };

describe("frozenSetHash", () => {
  test("matches the backend's hash of the fixture set (config.frozenSetHash)", () => {
    expect(frozenSetHash([...sources])).toBe(config.frozenSetHash as `0x${string}`);
  });
});

describe("checkSnapshot", () => {
  test("accepts a snapshot for this run", () => {
    expect(() => checkSnapshot(snapshot(), limits)).not.toThrow();
  });

  test("rejects another run's snapshot", () => {
    expect(() => checkSnapshot(snapshot({ runAt: 1 }), limits)).toThrow("expected 1791265800");
  });

  test("rejects a stale snapshot", () => {
    expect(() => checkSnapshot(snapshot({ takenAt: 1_791_265_600 }), limits)).toThrow("200s before the run");
  });

  test("rejects sources that don't hash to the frozen set", () => {
    const s = snapshot();
    s.sources[0] = { ...s.sources[0], weightE6: 1 };
    expect(() => checkSnapshot(s, limits)).toThrow("don't match the frozen set");
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
    const report = buildMirrorReport(config, 1_791_265_800, {
      snapshotId: "snap-1791265800",
      exposures: JSON.stringify([{ asset: "BTC", exposureE9: "1250000000" }, { asset: "ETH", exposureE9: "-500000000" }]),
      maxDeviationBps: 3,
      equityE6: 470_000_000n,
    });
    const [runId, snapshotId, asOf, frozen, equityE6, targets] = decodeAbiParameters(
      parseAbiParameters(REPORT_BODY_ABI),
      encodeReportBody(report),
    );
    expect(runId).toBe("mirror-1791265800");
    expect(snapshotId).toBe("snap-1791265800");
    expect(asOf).toBe(1_791_265_800n);
    expect(frozen).toBe(config.frozenSetHash as `0x${string}`);
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

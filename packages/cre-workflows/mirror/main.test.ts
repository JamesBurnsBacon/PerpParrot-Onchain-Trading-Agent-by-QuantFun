import { describe, expect, test } from "bun:test";
import { decodeAbiParameters, hexToBytes, parseAbiParameters } from "viem";
import configurationFixture from "../../backend/fixtures/frozen-configuration.json";
import type { FrozenConfiguration } from "../../shared/frozen";
import { REPORT_BODY_ABI } from "../../shared/report";
import type { PositionsSnapshot } from "../../shared/snapshot";
import staging from "./config.staging.json";
import { buildMirrorReport, initWorkflow, type Config } from "./main";
import { encodeReportBody, toEnvelope } from "./report";
import { checkSnapshot, pickSample } from "./snapshot";

const config = staging as Config;
const configuration = configurationFixture as FrozenConfiguration;
const RUN_AT = 1_791_281_400;
const LEAD = "0x1e37a337ed460039d1b15bd3bc489de789768d5e"; // weight 0.15

const snapshot = (overrides: Partial<PositionsSnapshot> = {}): PositionsSnapshot => ({
  snapshotId: `snap-${RUN_AT}`,
  runAt: RUN_AT,
  takenAt: RUN_AT - 60,
  configuration,
  eligibleAssets: ["BTC", "ETH"],
  sources: configuration.sources
    .map((s) => s.sourceAddress)
    .sort()
    .map((address) => ({ address, equityE6: "1000000000", positions: [{ asset: "BTC", notionalE6: "500000000" }] })),
  ...overrides,
});

const limits = { frozenConfigurationHash: config.frozenConfigurationHash, runAt: RUN_AT, maxSnapshotAgeSeconds: 120 };

describe("config", () => {
  test("pins the fixture configuration", () => {
    expect(config.frozenConfigurationHash).toBe(configuration.configurationHash);
  });
});

describe("checkSnapshot", () => {
  test("accepts a snapshot for this run and attaches frozen weights and ceilings", () => {
    const sources = checkSnapshot(snapshot(), limits);
    const byAddress = new Map(sources.map((s) => [s.address, s.weightE6]));
    expect(byAddress.get(LEAD)).toBe(150_000);
    expect([...byAddress.values()].reduce((a, b) => a + b, 0)).toBe(750_000); // 25% cash
    expect(sources.every((s) => s.ceilingE6 === 300_000)).toBe(true);
  });

  test("rejects another run's snapshot", () => {
    expect(() => checkSnapshot(snapshot({ runAt: 1 }), limits)).toThrow(`expected ${RUN_AT}`);
  });

  test("rejects a stale snapshot", () => {
    expect(() => checkSnapshot(snapshot({ takenAt: RUN_AT - 200 }), limits)).toThrow("200s before the run");
  });

  test("rejects a configuration that isn't the pinned one", () => {
    expect(() => checkSnapshot(snapshot(), { ...limits, frozenConfigurationHash: `0x${"00".repeat(32)}` })).toThrow(
      "not the pinned frozen authority",
    );
  });

  test("rejects a tampered configuration", () => {
    // Moves weight between sources: totals still add up, the commitment doesn't.
    const sources = configuration.sources.map((s, i) =>
      i === 0 ? { ...s, weightUnits: 160_000 } : i === 1 ? { ...s, weightUnits: 90_000 } : s,
    );
    expect(() => checkSnapshot(snapshot({ configuration: { ...configuration, sources } }), limits)).toThrow(
      "frozen commitment mismatch",
    );
  });

  test("rejects renormalization past a source's ceiling", () => {
    // Only the 0.15-weight source is active: it would carry 0.75 against a 0.3 ceiling.
    const s = snapshot();
    s.sources = s.sources.map((src) => (src.address === LEAD ? src : { ...src, positions: [] }));
    expect(() => checkSnapshot(s, limits)).toThrow("active-source concentration exceeds ceiling");
  });

  test("rejects sources that differ from the frozen configuration", () => {
    const s = snapshot();
    s.sources[0] = { ...s.sources[0], address: "0x0000000000000000000000000000000000000001" };
    expect(() => checkSnapshot(s, limits)).toThrow("don't match the frozen configuration");
    expect(() => checkSnapshot(snapshot({ sources: snapshot().sources.slice(1) }), limits)).toThrow(
      "don't match the frozen configuration",
    );
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
  test("carries the agreed exposures and round-trips through the shared ABI", () => {
    const report = buildMirrorReport(config, RUN_AT, {
      snapshotId: `snap-${RUN_AT}`,
      account: configuration.account,
      snapshotHash: `0x${"5e".repeat(32)}`,
      exposures: JSON.stringify([
        { asset: "BTC", exposureE9: "1250000000" },
        { asset: "ETH", exposureE9: "-500000000" },
      ]),
      maxDeviationBps: 3,
    });
    const [runId, snapshotHash, configurationHash, account, asOf, expiresAt, exposures] = decodeAbiParameters(
      parseAbiParameters(REPORT_BODY_ABI),
      encodeReportBody(report),
    );
    expect(runId).toBe(`mirror-${RUN_AT}`);
    expect(snapshotHash).toBe(`0x${"5e".repeat(32)}`);
    expect(configurationHash).toBe(config.frozenConfigurationHash as `0x${string}`);
    expect(account.toLowerCase()).toBe(configuration.account);
    expect(asOf).toBe(BigInt(RUN_AT));
    expect(expiresAt).toBe(BigInt(RUN_AT + config.reportTtlSeconds));
    expect(exposures).toEqual([
      { asset: "BTC", exposureE9: 1_250_000_000n },
      { asset: "ETH", exposureE9: -500_000_000n },
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

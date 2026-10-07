import { describe, expect, test } from "bun:test";
import configurationFixture from "../fixtures/frozen-configuration.json";
import type { FrozenConfiguration } from "../../shared/frozen";
import type { PositionsSnapshot } from "../../shared/snapshot";
import { capGrossExposure, computeExposures, limitPositions, targetsFromSnapshot, weightedSourcesFromSnapshot } from "../../shared/copy";
import { exposureBreakdown } from "../src/paper/exposure-breakdown";

const snapshot = (): PositionsSnapshot => ({
  snapshotId: "breakdown", runAt: 600, takenAt: 540,
  configuration: structuredClone(configurationFixture) as FrozenConfiguration,
  eligibleAssets: ["BTC", "ETH"],
  sources: configurationFixture.sources.map((s) => ({
    address: s.sourceAddress, equityE6: "1000000000000",
    positions: [{ asset: "BTC", notionalE6: "500000000000" }],
  })),
});

function three(): PositionsSnapshot {
  const s = snapshot();
  s.sources = s.sources.slice(0, 3);
  s.configuration.sources = s.configuration.sources.slice(0, 3);
  s.configuration.sources.forEach((source, i) => { source.weightUnits = [500_000, 300_000, 200_000][i]; });
  s.sources[1].positions = [{ asset: "ETH", notionalE6: "-1000000000000" }];
  s.sources[2].positions = [{ asset: "BTC", notionalE6: "1000000000000" }];
  return s;
}

function reconcile(s: PositionsSnapshot) {
  const before = structuredClone(s);
  const breakdown = exposureBreakdown(s);
  const targets = targetsFromSnapshot(s).filter((e) => e.exposureE9 !== 0n);
  expect(s).toEqual(before);
  expect(breakdown.map((b) => b.address)).toEqual(s.sources.map((source) => source.address));
  for (const target of targets) {
    const total = breakdown.flatMap((b) => b.contributions).filter((c) => c.asset === target.asset).reduce((sum, c) => sum + c.fraction, 0);
    const expected = Number(target.exposureE9) / 1e9;
    expect(Math.abs(total - expected)).toBeLessThanOrEqual(Math.abs(expected) * 1e-9);
  }
  for (const source of breakdown) for (const c of source.contributions) {
    expect(Number.isFinite(c.fraction)).toBe(true);
    expect(targets.some((t) => t.asset === c.asset)).toBe(true);
  }
  return breakdown;
}

describe("weighted snapshot extraction preserves targets and errors", () => {
  test("existing paper-service snapshot: 0.75 invested × 0.5 BTC, including flat exits", () => {
    const s = snapshot();
    expect(targetsFromSnapshot(s)).toEqual([{ asset: "BTC", exposureE9: 375_000_000n }]);
    const { sources, maxGrossE9 } = weightedSourcesFromSnapshot(s);
    expect(sources.map((source) => source.weightE6)).toEqual(configurationFixture.sources.map((source) => source.weightUnits));
    expect(maxGrossE9).toBe(3_000_000_000n);
    expect(capGrossExposure(limitPositions(computeExposures(sources)), maxGrossE9)).toEqual(targetsFromSnapshot(s));
    s.sources.slice(1).forEach((source) => { source.positions = []; });
    expect(targetsFromSnapshot(s)).toEqual([{ asset: "BTC", exposureE9: 75_000_000n }]);
    s.sources[0].positions = [];
    expect(targetsFromSnapshot(s)).toEqual([]);
  });

  const invalid: [string, (s: PositionsSnapshot) => void][] = [
    ["source 0xunknown is not in the frozen configuration", (s) => { s.sources[0].address = "0xunknown"; }],
    ["ineligible asset in snapshot: BTC", (s) => { s.eligibleAssets = []; }],
    ["winding-down source 0xunknown is not in the frozen configuration", (s) => { s.windDown = [{ address: "0xunknown", caps: [] }]; }],
    ["normalized source 0xunknown is not in the frozen configuration", (s) => { s.leverage = [{ address: "0xunknown", scaleE6: "1" }]; }],
    [`invalid leverage scale for ${configurationFixture.sources[0].sourceAddress}`, (s) => { s.leverage = [{ address: s.sources[0].address, scaleE6: "0" }]; }],
  ];
  for (const [message, change] of invalid) test(message, () => {
    const s = snapshot(); change(s);
    for (const fn of [weightedSourcesFromSnapshot, targetsFromSnapshot, exposureBreakdown]) expect(() => fn(s)).toThrow(message);
  });
});

describe("exposureBreakdown", () => {
  test("plain three-source contributions and frozen weights", () => {
    const rows = reconcile(three());
    expect(rows.map((r) => r.weight)).toEqual([0.5, 0.3, 0.2]);
    expect(rows.map((r) => r.contributions)).toEqual([
      [{ asset: "BTC", fraction: 0.25 }], [{ asset: "ETH", fraction: -0.3 }], [{ asset: "BTC", fraction: 0.2 }],
    ]);
  });

  test("leverage normalization, source cap and final portfolio cap", () => {
    const s = three();
    s.configuration.policy.maxGrossLeverage = 1;
    s.leverage = [{ address: s.sources[0].address, scaleE6: "20000000" }];
    s.sources[2].positions[0].notionalE6 = "5000000000000";
    const rows = reconcile(s);
    expect(targetsFromSnapshot(s)).toEqual([{ asset: "BTC", exposureE9: 909_090_909n }, { asset: "ETH", exposureE9: -181_818_181n }]);
    expect(rows[0].contributions[0].fraction).toBeCloseTo(0.909090909 / 3, 12);
  });

  test("wind-down caps exclude new and flipped positions", () => {
    const s = three();
    s.sources[0].positions.push({ asset: "ETH", notionalE6: "1000000000000" });
    s.windDown = [
      { address: s.sources[0].address, caps: [{ asset: "BTC", leverageE9: "200000000" }] },
      { address: s.sources[1].address, caps: [{ asset: "ETH", leverageE9: "500000000" }] },
    ];
    const rows = reconcile(s);
    expect(rows[0].contributions).toEqual([{ asset: "BTC", fraction: 0.1 }]);
    expect(rows[1].contributions).toEqual([]);
    expect(targetsFromSnapshot(s)).toEqual([{ asset: "BTC", exposureE9: 300_000_000n }]);
  });

  test("position limit drops small assets and scales kept contributions", () => {
    const s = three();
    const positions = Array.from({ length: 17 }, (_, i) => ({ asset: `P${i}`, notionalE6: String((i + 1) * 1e9) }));
    s.eligibleAssets = positions.map((p) => p.asset);
    s.sources.forEach((source) => { source.positions = positions; });
    const rows = reconcile(s);
    expect(rows[0].contributions).toHaveLength(15);
    expect(rows.flatMap((r) => r.contributions).some((c) => c.asset === "P0" || c.asset === "P1")).toBe(false);
    expect(rows[0].contributions.find((c) => c.asset === "P16")!.fraction).toBeGreaterThan(0.0085);
  });

  test("offsetting longs and shorts keep their individual signs", () => {
    const s = three();
    s.sources[1].positions = [{ asset: "BTC", notionalE6: "-1000000000000" }];
    const rows = reconcile(s);
    expect(rows.map((r) => r.contributions[0].fraction)).toEqual([0.25, -0.3, 0.2]);
    expect(targetsFromSnapshot(s)).toEqual([{ asset: "BTC", exposureE9: 150_000_000n }]);
  });

  test("exact cancellation never divides by zero; flat and zero-equity wallets remain", () => {
    const s = three();
    s.sources[1].positions = [{ asset: "BTC", notionalE6: "-1500000000000" }];
    expect(reconcile(s).every((r) => r.contributions.length === 0)).toBe(true);
    s.sources[1].positions = [];
    s.sources[2].equityE6 = "0";
    const rows = reconcile(s);
    expect(rows[1]).toEqual({ address: s.sources[1].address, weight: 0.3, contributions: [] });
    expect(rows[2].contributions).toEqual([]);
  });

  test("zero final cap omits all assets, even when raw net is nonzero", () => {
    const s = three(); s.configuration.policy.maxGrossLeverage = 0;
    expect(reconcile(s).every((r) => r.contributions.length === 0)).toBe(true);
  });
});

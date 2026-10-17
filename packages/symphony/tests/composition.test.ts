import { describe, it, expect } from "vitest";
import { composeSources } from "../src/data/composition";
import { sources } from "../src/data";
describe("signed preview composition", () => {
  it("excludes the short source without silently renormalizing", () => {
    const preview = composeSources(sources, ["quiet"], 10000);
    expect(preview.netBTC).toBe(35);
    expect(preview.netETH).toBe(18);
    expect(preview.sourceGross).toBe(53);
    expect(preview.portfolioGross).toBe(53);
    expect(preview.activeWeight).toBe(85);
    expect(preview.orders.map((order) => order.targetUsd)).toEqual([
      3500, 1800,
    ]);
  });
  it("all removed has zero exposure and no orders", () => {
    const preview = composeSources(
      sources,
      sources.map((source) => source.id),
      10000,
    );
    expect(preview.activeSources).toEqual([]);
    expect(preview.netBTC).toBe(0);
    expect(preview.netETH).toBe(0);
    expect(preview.sourceGross).toBe(0);
    expect(preview.portfolioGross).toBe(0);
    expect(preview.activeWeight).toBe(0);
    expect(preview.orders).toEqual([]);
  });
  it("capital changes notionals while preserving composition", () => {
    const a = composeSources(sources, [], 10000),
      b = composeSources(sources, [], 20000);
    expect(b.netBTC).toBe(a.netBTC);
    expect(b.netETH).toBe(a.netETH);
    expect(b.sourceGross).toBe(a.sourceGross);
    expect(b.orders.map((order) => order.targetUsd)).toEqual(
      a.orders.map((order) => order.targetUsd * 2),
    );
  });
  it("negative contributions create signed targets and sell intent", () => {
    const preview = composeSources(
      sources.filter((source) => source.id === "quiet"),
      [],
      10000,
    );
    expect(preview.orders[0]).toEqual({
      asset: "ETH",
      isBuy: false,
      notionalUsd: 600,
      targetUsd: -600,
      currentUsd: 0,
    });
  });
  it("rejects invalid capital before a misleading preview is generated", () => {
    for (const amount of [NaN, Infinity, 0, 99, 100000001])
      expect(() => composeSources(sources, [], amount)).toThrow(RangeError);
  });
});

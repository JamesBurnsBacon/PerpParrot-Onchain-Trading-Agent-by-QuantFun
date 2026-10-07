import { describe, expect, test } from "bun:test";
import { checkBacktestArtifact, checkFunnelArtifact, type BacktestArtifact, type FunnelArtifact } from "../../shared/dashboard";

const t0 = Date.UTC(2026, 8, 1);
const day = 86_400e3;
const backtest = (): BacktestArtifact => ({
  generatedAt: Date.UTC(2026, 9, 6),
  window: "1 month",
  series: [
    { id: "algo", label: "Algo only", points: [[t0, 1], [t0 + day, 1.012]] },
    { id: "btc", label: "BTC buy & hold", points: [[t0, 1], [t0 + day, 0.995]] },
  ],
});
const funnel = (): FunnelArtifact => ({
  generatedAt: Date.UTC(2026, 9, 6),
  steps: [
    { stage: "universe", label: "Addresses", count: 47_000 },
    { stage: "finalists", label: "Finalists", count: 40 },
    { stage: "frozen", label: "Frozen set", count: 11 },
  ],
  finalists: [{ address: `0x${"ab".repeat(20)}`, kind: "vault", score: 0.91, picked: true, rationale: "steady" }],
});

describe("checkBacktestArtifact", () => {
  test("accepts a well-formed artifact", () => expect(checkBacktestArtifact(backtest())).toEqual([]));

  test("catches seconds instead of milliseconds", () => {
    const a = backtest();
    a.series[0].points = [[t0 / 1000, 1], [(t0 + day) / 1000, 1.01]];
    expect(checkBacktestArtifact(a).join()).toContain("unix ms");
  });

  test("catches a series not indexed to 1.0", () => {
    const a = backtest();
    a.series[0].points = [[t0, 470], [t0 + day, 480]];
    expect(checkBacktestArtifact(a).join()).toContain("indexed to 1.0");
  });

  test("requires the BTC benchmark, unique ids and increasing time", () => {
    const a = backtest();
    a.series = [a.series[0], { ...a.series[0], points: [[t0 + day, 1], [t0, 1]] }];
    const problems = checkBacktestArtifact(a).join("\n");
    expect(problems).toContain('id "btc"');
    expect(problems).toContain("unique");
    expect(problems).toContain("increasing time");
  });
});

describe("checkFunnelArtifact", () => {
  test("accepts a well-formed artifact", () => expect(checkFunnelArtifact(funnel())).toEqual([]));

  test("catches a stage larger than the one before", () => {
    const a = funnel();
    a.steps[2].count = 41;
    expect(checkFunnelArtifact(a).join()).toContain("larger than the step before");
  });

  test("checks finalists: address, duplicates, picked", () => {
    const a = funnel();
    a.finalists = [
      { address: "0x123", kind: "leader", score: 1, picked: true },
      { address: `0x${"AB".repeat(20)}`, kind: "vault", score: 0.5, picked: "yes" as unknown as boolean },
      { address: `0x${"ab".repeat(20)}`, kind: "vault", score: 0.4, picked: false },
    ];
    const problems = checkFunnelArtifact(a).join("\n");
    expect(problems).toContain("0x + 40 hex");
    expect(problems).toContain("picked must be true or false");
    expect(problems).toContain("listed twice");
  });
});

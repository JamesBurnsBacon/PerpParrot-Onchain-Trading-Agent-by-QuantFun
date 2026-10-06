import { describe, expect, test } from "bun:test";
import { computeMetrics, type Metrics, type ScoreConfig, type ScoreInput, type TimePoint } from "../../src/score";
import cases from "../fixtures/score/metrics-cases.json";
import { expectFinite, expectOutput, sampleInputs, toInput, type RawInput } from "./helpers";

const DAY = 86_400_000;
const BASE = 20_718 * DAY;

const metricsOf = (input: ScoreInput, config: Partial<ScoreConfig> = {}): Metrics => {
  const metrics = computeMetrics(input, config);
  if (metrics === null) throw new Error("expected metrics");
  return metrics;
};

// Account value = 100k + cumulative PnL, so there are no flows and C_t = AV_t / AV_0.
const window = (days: number[], pnl: (day: number) => number) => ({
  accountValueHistory: days.map((day): TimePoint => [BASE + day * DAY, 100_000 + pnl(day)]),
  pnlHistory: days.map((day): TimePoint => [BASE + day * DAY, pnl(day)]),
});

const range = (from: number, to: number, step = 1): number[] =>
  Array.from({ length: Math.floor((to - from) / step) + 1 }, (_, i) => from + i * step);

const stitched = (allTimeDays: number[], pnl: (day: number) => number): ScoreInput => {
  const month = window(range(60, 90), pnl);
  const monthStart = pnl(60);
  return {
    address: "a",
    kind: "trader",
    accountValue: 100_000 + pnl(90),
    closed: false,
    tradeCount: 50,
    history: null,
    allTime: window(allTimeDays, pnl),
    // month PnL starts at 0 at its window start; the allTime offset restores the baseline (SPEC "Baselines").
    month: { ...month, pnlHistory: month.pnlHistory.map(([ts, value]): TimePoint => [ts, value - monthStart]) },
  };
};

describe("computeMetrics fixtures (SPEC Metrics)", () => {
  for (const fixture of cases as unknown as { name: string; input: RawInput; config?: Partial<ScoreConfig>; expected: unknown }[]) {
    test(fixture.name, () => {
      const actual = computeMetrics(toInput(fixture.input), fixture.config ?? {});
      expectOutput(actual, fixture.expected);
      expectFinite(actual);
    });
  }
});

describe("computeMetrics properties", () => {
  test("never exposes non-finite arithmetic results", () => {
    for (const equity of [Number.MIN_VALUE, 1, Number.MAX_VALUE]) {
      for (const pnl of [[-Number.MAX_VALUE, Number.MAX_VALUE, 0], [0, Number.MAX_VALUE, -Number.MAX_VALUE]]) {
        const metrics = computeMetrics({
          address: "a", kind: "trader", accountValue: equity, closed: false, tradeCount: 50, allTime: null, history: null,
          month: {
            accountValueHistory: [[0, equity], [DAY, equity], [2 * DAY, equity]],
            pnlHistory: pnl.map((value, i): TimePoint => [i * DAY, value]),
          },
        });
        expectFinite(metrics);
      }
    }
  });

  test("a deposit with no PnL creates no return", () => {
    const metrics = metricsOf({
      address: "a", kind: "trader", accountValue: 300_000, closed: false, tradeCount: 50, allTime: null, history: null,
      month: {
        accountValueHistory: [[BASE, 100_000], [BASE + DAY, 300_000], [BASE + 2 * DAY, 300_000]],
        pnlHistory: [[BASE, 0], [BASE + DAY, 0], [BASE + 2 * DAY, 0]],
      },
    });
    expect(metrics.periodReturn).toBe(0);
    expect(metrics.flags).not.toContain("dust-equity");
  });

  test("the 7-day grid gives daily and weekly allTime accounts the same drawdown (SPEC Metrics)", () => {
    // A 6% dip inside a week, recovered by the week's end, then steady growth.
    const pnl = (day: number) => day === 10 ? -6_000 : day * 100;
    const daily = metricsOf(stitched(range(0, 90), pnl));
    const weekly = metricsOf(stitched([...range(0, 56, 7), 90], pnl));
    expect(daily.maxDrawdown).not.toBeNull();
    expect(Math.abs(daily.maxDrawdown! - weekly.maxDrawdown!)).toBeLessThanOrEqual(1e-12);
    expect(daily.maxDrawdown!).toBeLessThan(0.06);
    expect(daily.flags).not.toContain("stitch-mismatch");
    expect(weekly.flags).not.toContain("stitch-mismatch");
  });

  test("an allTime that disagrees with month at a shared timestamp is not stitched", () => {
    const input = stitched(range(0, 90), (day) => day * 100);
    const allTime = input.allTime!;
    const pnlHistory = allTime.pnlHistory.map(([ts, value], i): TimePoint => i === 70 ? [ts, value + 1] : [ts, value]);
    const metrics = metricsOf({ ...input, allTime: { ...allTime, pnlHistory } });
    expect(metrics.flags).toContain("stitch-mismatch");
    expect(metrics.lookbackDays).toBe(30);
  });

  test("every real sample account stitches exactly (SPEC Baselines)", () => {
    for (const input of sampleInputs) {
      const metrics = metricsOf(input);
      expect(metrics.flags, input.address).not.toContain("stitch-mismatch");
      expect(metrics.lookbackDays, input.address).toBeGreaterThan(30);
    }
  });

  test("a near-empty account that receives a deposit cannot post a huge return (addr-08 regression)", () => {
    const metrics = metricsOf(sampleInputs.find(({ address }) => address === "addr-08")!);
    expect(metrics.flags).toEqual(expect.arrayContaining(["dust-equity", "low-coverage"]));
    expect(metrics.skippedTimeShare).toBeGreaterThan(0.2);
    for (const ratio of [metrics.sharpe, metrics.sortino, metrics.calmar]) {
      if (typeof ratio === "number") expect(Math.abs(ratio)).toBeLessThan(1_000);
    }
  });
});

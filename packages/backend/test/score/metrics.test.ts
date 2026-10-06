import { describe, expect, test } from "bun:test";
import { computeMetrics, type Metrics, type ScoreConfig, type ScoreInput, type TimePoint } from "../../src/score";
import { curveAt, gridSamples, type CurvePoint } from "../../src/score/metrics";
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

// Found by reviewing the revision 2 implementation against SPEC.md (independent fuzzing found no metric differences).
describe("computeMetrics edge cases", () => {
  // Account value = 1,000 + cumulative PnL, so there are no flows and the curve is AV / 1,000.
  const flat = (days: number[], pnl: number[]) => ({
    accountValueHistory: days.map((day, i): TimePoint => [BASE + day * DAY, 1_000 + pnl[i]]),
    pnlHistory: days.map((day, i): TimePoint => [BASE + day * DAY, pnl[i]]),
  });
  const input = (month: ScoreInput["month"], allTime: ScoreInput["allTime"] = null): ScoreInput =>
    ({ address: "a", kind: "trader", accountValue: 10_000, closed: false, tradeCount: 10, history: null, month, allTime });

  // allTime points on days 0..4; the month window is days 3..4. The curve is 1, 1.5, 1.25, 1.3, 1.4, so the drawdown
  // of 1/6 (1.5 -> 1.25) is only seen when the grid samples days 1 and 2.
  const drawdownCase = input(flat([3, 4], [300, 400]), flat([0, 1, 2, 3, 4], [0, 500, 250, 300, 400]));

  test("the drawdown grid follows coarseGridDays (SPEC Metrics)", () => {
    expect(metricsOf(drawdownCase).maxDrawdown).toBe(0);
    expect(metricsOf(drawdownCase, { coarseGridDays: 1 }).maxDrawdown).toBeCloseTo(1 / 6, 12);
  });

  test("a tiny coarseGridDays terminates and samples every curve point", () => {
    expect(metricsOf(drawdownCase, { coarseGridDays: 1e-30 }).maxDrawdown).toBeCloseTo(1 / 6, 12);
  });

  test("a step that overflows keeps only the first grid time; one denser than a millisecond samples every segment", () => {
    expect(metricsOf(drawdownCase, { coarseGridDays: 1e300 }).maxDrawdown).toBe(0);
    expect(metricsOf(drawdownCase, { coarseGridDays: 5e-324 }).maxDrawdown).toBeCloseTo(1 / 6, 12);
  });

  test("gridSamples visits the same curve values as walking every grid time (SPEC Metrics)", () => {
    // Reference: the curve value at each firstTs + k * step before fineStart, consecutive repeats removed.
    const reference = (curve: CurvePoint[], firstTs: number, fineStart: number, step: number): number[] => {
      const values: number[] = [];
      for (let k = 0; firstTs + k * step < fineStart; k++) values.push(curveAt(curve, firstTs + k * step));
      return values.filter((value, i) => i === 0 || value !== values[i - 1]);
    };
    const compress = (values: number[]): number[] => values.filter((value, i) => i === 0 || value !== values[i - 1]);
    let seed = 12_345;
    const random = (): number => (seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648) / 2_147_483_648;
    const steps = [DAY, 7 * DAY, DAY / 2, 3 * DAY + 5, 1_234_567.89, 86_400_000 * 0.1, 100_000];
    for (let n = 0; n < 300; n++) {
      const step = steps[Math.floor(random() * steps.length)];
      const firstTs = BASE + Math.floor(random() * 1_000_000);
      const count = 1 + Math.floor(random() * 10);
      const curve: CurvePoint[] = [{ ts: firstTs, value: 1 }];
      for (let i = 1; i < count; i++) {
        // Half of the points sit exactly on a grid time (for an integer-millisecond step), the rest anywhere.
        const onGrid = random() < 0.5 && Number.isInteger(step);
        const ts = onGrid
          ? firstTs + Math.max(Math.round((curve[i - 1].ts - firstTs) / step) + 1 + Math.floor(random() * 3), 1) * step
          : curve[i - 1].ts + 1 + Math.floor(random() * 5 * step);
        curve.push({ ts, value: 0.5 + random() });
      }
      const fineStart = curve[curve.length - 1].ts + Math.floor(random() * 2 * step);
      if ((fineStart - firstTs) / step > 20_000 || fineStart <= firstTs) continue;
      expect(compress(gridSamples(curve, firstTs, fineStart, step)), `case ${n}`).toEqual(reference(curve, firstTs, fineStart, step));
    }
  });

  test("computeMetrics validates the configuration even without a month window", () => {
    expect(() => computeMetrics(input(null), { lookbackDays: 0 })).toThrow("lookbackDays");
    expect(() => computeMetrics(drawdownCase, { coarseGridDays: Infinity })).toThrow("coarseGridDays");
  });

  test("skippedTimeShare is exact at the coverage limit", () => {
    // Intervals of 0.2, 0.7 and 0.1 days; only the first starts from zero equity and is skipped.
    const month = {
      accountValueHistory: [[0, 0], [17_280_000, 0], [77_760_000, 1], [DAY, 2]] as TimePoint[],
      pnlHistory: [[0, 0], [17_280_000, 0], [77_760_000, 0], [DAY, 1]] as TimePoint[],
    };
    const metrics = metricsOf(input(month));
    expect(metrics.flags).toContain("dust-equity");
    expect(metrics.skippedTimeShare).toBe(0.2);
    expect(metrics.flags).not.toContain("low-coverage");
  });

  test("a non-finite timestamp makes the series invalid instead of leaking NaN", () => {
    const month = { accountValueHistory: [[0, 100], [Infinity, 100]] as TimePoint[], pnlHistory: [[0, 0], [Infinity, 1]] as TimePoint[] };
    expect(computeMetrics(input(month))).toBeNull();
  });
});

import { describe, expect, test } from "bun:test";
import { FILLS_PAGE, fillStats, isHighFrequency, pickLeaderboard, sameAddresses, scoringWindows, type Fill, type LeaderboardRow } from "../src/pipeline/derive";
import { decodeSeroval } from "../src/pipeline/vaults";
import { basicSources } from "../src/pipeline";
import { PacedInfo } from "../src/pipeline/hl";
import type { Policy, Row } from "../../shared/src/contracts.ts";

const DAY = 86_400_000;
const NOW = Date.parse("2026-10-07T12:00:00Z");

describe("fillStats", () => {
  test("counts distinct (coin, oid) once and takes the 30-day maker share by notional", () => {
    const fill = (coin: string, oid: number, px: string, sz: string, crossed: boolean, ageDays: number) => ({ coin, oid, px, sz, crossed, time: NOW - ageDays * DAY });
    const stats = fillStats(
      [
        fill("BTC", 1, "100", "1", false, 1), // maker 100
        fill("BTC", 1, "100", "1", false, 1), // same order, partial fill
        fill("ETH", 2, "10", "30", true, 2), // taker 300
        fill("ETH", 3, "10", "100", false, 40), // outside 30 days
      ],
      NOW,
    );
    expect(stats.tradeCount).toBe(3);
    expect(stats.makerShare).toBeCloseTo(200 / 500);
    expect(stats.ordersPerDay).toBeCloseTo(3 / 30); // a partial page covers the 30 days asked for
  });

  test("a full page is the oldest 2,000 fills: orders per day over the page's own span", () => {
    // 2,000 fills, one order each, over 2 days: 1,000 orders a day, a high-frequency trader.
    const fills: Fill[] = Array.from({ length: FILLS_PAGE }, (_, i) => ({ coin: "BTC", oid: i, px: "1", sz: "1", crossed: true, time: NOW - 10 * DAY + (i * 2 * DAY) / (FILLS_PAGE - 1) }));
    const { ordersPerDay } = fillStats(fills, NOW);
    expect(ordersPerDay).toBeCloseTo(1_000);
    expect(isHighFrequency(ordersPerDay)).toBe(true);
    expect(isHighFrequency(45)).toBe(false);
    expect(isHighFrequency(null)).toBe(false); // unknown isn't high-frequency; Score's minTrades decides
  });

  test("no recent fills: maker share unknown", () => {
    expect(fillStats([], NOW)).toEqual({ tradeCount: 0, makerShare: null, ordersPerDay: null });
  });
});

describe("pickLeaderboard", () => {
  const row = (address: string, value: number, month: number, allTime: number): LeaderboardRow => ({
    ethAddress: address,
    accountValue: String(value),
    displayName: null,
    windowPerformances: [["month", { pnl: String(month), roi: "0", vlm: "0" }], ["allTime", { pnl: String(allTime), roi: "0", vlm: "0" }]],
  });

  test("≥ $10k, positive month and all-time PnL, by month PnL, vaults excluded", () => {
    const rows = [
      row("0xAA", 50_000, 10, 5), row("0xbb", 9_000, 100, 100), row("0xcc", 50_000, -1, 100),
      row("0xdd", 50_000, 50, 1), row("0xee", 50_000, 200, 1),
    ];
    const picked = pickLeaderboard(rows, 2, new Set(["0xee"]));
    expect(picked.map((p) => p.address)).toEqual(["0xdd", "0xaa"]);
    expect(picked[0]).toMatchObject({ source: "leaderboard", kind: "trader", closed: false });
  });
});

test("scoringWindows keeps only month and allTime", () => {
  const window = { accountValueHistory: [], pnlHistory: [] };
  expect(scoringWindows([["day", window], ["month", window], ["perpMonth", window], ["allTime", window]])).toEqual([["month", window], ["allTime", window]]);
});

test("sameAddresses ignores order and case", () => {
  expect(sameAddresses(["0xAA", "0xbb"], ["0xbb", "0xaa"])).toBe(true);
  expect(sameAddresses(["0xaa", "0xbb"], ["0xaa"])).toBe(false);
  expect(sameAddresses(["0xaa", "0xbb"], ["0xaa", "0xcc"])).toBe(false);
  expect(sameAddresses([], [])).toBe(true);
});

test("decodeSeroval: the site's object/array/number/string/constant nodes", () => {
  const wire = {
    t: 10, i: 0,
    p: { k: ["result", "error"], v: [{ t: 9, i: 1, a: [{ t: 10, i: 2, p: { k: ["vault_address", "current_tvl", "ok"], v: [{ t: 1, s: "0xAb" }, { t: 0, s: 12.5 }, { t: 2, s: 2 }] } }] }, { t: 2, s: 0 }] },
  };
  expect(decodeSeroval(wire)).toEqual({ result: [{ vault_address: "0xAb", current_tvl: 12.5, ok: true }], error: null });
});

describe("basicSources", () => {
  const policy = { bucket: "AGGRESSIVE", riskRejectThreshold: 80, maxSourceWeight: 0.3, cashBuffer: 0.1, maxGrossLeverage: 3 } as unknown as Policy;
  const addresses = new Map([0, 1, 2, 3].map((c) => [c, `0x${String(c).repeat(40)}`]));
  const role = (candidate: number, aggressiveFit: number, reject = 0) => ({ candidate, aggressiveFit, reject }) as unknown as Row;
  const risk = (candidate: number, worst = 50, evidenceRisk = 80) =>
    ({ candidate, drawdownRisk: 20, leverageRisk: worst, concentrationRisk: 20, pathRisk: 80, executionRisk: 20, evidenceRisk }) as unknown as Row;
  const flat = () => ({ executableTargets: 5, grossLeverage: 1, withinPolicy: true });

  test("drops AI rejects and risks above the threshold; ignores evidence risk; weights by fit within caps", () => {
    const sources = basicSources(
      [0, 1, 2, 3],
      [role(0, 90), role(1, 30), role(2, 60, 85), role(3, 40)],
      [risk(0, 50, 95), risk(1), risk(2), risk(3, 90)],
      policy, addresses, flat,
    );
    expect(sources.map((s) => s.candidate)).toEqual([0, 1]); // 2: Role reject ≥ 80; 3: leverage risk 90
    expect(sources[0].weight).toBeCloseTo(0.3); // 0.9 × 90/120 = 0.675, capped
    expect(sources[1].weight).toBeCloseTo(0.225); // 0.9 × 30/120
  });

  test("scales to the policy's gross leverage", () => {
    const sources = basicSources([0, 1], [role(0, 50), role(1, 50)], [risk(0), risk(1)], policy, addresses, () => ({ executableTargets: 2, grossLeverage: 6, withinPolicy: false }));
    expect(sources[0].weight).toBeCloseTo(0.3 * (0.95 * 3) / 6);
  });
});

test("PacedInfo: concurrent reads share one budget", async () => {
  const waits: number[] = [];
  const ok = (async () => Response.json([])) as unknown as typeof fetch;
  const started = Date.now();
  const hl = new PacedInfo(60, ok, async (ms) => void waits.push(Math.round((ms + Date.now() - started) / 1000)));
  await Promise.all([1, 2, 3].map(() => hl.post({ type: "portfolio" }, 20)));
  expect(waits).toEqual([20, 40, 60]); // 20 weight each at 60 a minute
});

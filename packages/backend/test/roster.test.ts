import { describe, expect, test } from "bun:test";
import { holdMeasures, type HlFill } from "../src/pipeline/evidence";
import {
  capsFrom, impliedTurnover, lossBreached, observe, passesHoldGate, planAdmissions, pnlAndEquity, ratchetCaps, reviewSeat, ROSTER,
  targetSeats, tenureMs, transition, type BenchEntry, type Seat, type Verdict,
} from "../src/pipeline/roster";

const HOUR = 3_600_000;
const NOW = Date.parse("2026-10-08T00:00:00Z");
const addr = (i: number) => `0x${(i + 1).toString(16).padStart(40, "0")}`;

const seat = (over: Partial<Seat> = {}): Seat => ({
  address: addr(0), state: "seated", weightUnits: 90_000, fit: 60, turnoverPerDay: 1, tradedPerDayOverEquity: 0.5,
  admittedAt: NOW - 48 * HOUR, minTenureUntil: NOW - 24 * HOUR, flatSince: null, flatRuns: 0, lastRunAt: null,
  equityAtAdmission: 100_000, pnlAtAdmission: 10_000, windDownUntil: null, caps: null, reviewedAt: null, unqualifiedReviews: 0, ...over,
});
const bench = (i: number, fit: number, over: Partial<BenchEntry> = {}): BenchEntry => ({
  address: addr(i), fit, approvedAt: NOW - HOUR, copyableShare: 0.8, closedPositions: 10, turnoverPerDay: 0.5,
  tradedPerDayOverEquity: 0.2, passesHold: true, ...over,
});
const admissionInput = (active: Seat[], b: BenchEntry[], over: Partial<Parameters<typeof planAdmissions>[0]> = {}) => ({
  active, bench: b, cooling: new Set<string>(), admittedLastHour: 0, admittedLastDay: 0, nowMs: NOW, cashBuffer: 0.1, maxSourceWeight: 0.3, ...over,
});

describe("tenure and the hold gate (owner D1, D5)", () => {
  test("tenure is 3 book lifetimes within 12–72 h; unknown turnover gets 24 h", () => {
    expect(tenureMs(6)).toBe(12 * HOUR);
    expect(tenureMs(2.5)).toBeCloseTo(28.8 * HOUR);
    expect(tenureMs(0.2)).toBe(72 * HOUR);
    expect(tenureMs(0)).toBe(72 * HOUR);
    expect(tenureMs(null)).toBe(24 * HOUR);
    expect(tenureMs(100)).toBe(12 * HOUR);
  });

  test("copyable: half the closed notional held ≥ 90 min, or a book turning over at most once a day", () => {
    expect(passesHoldGate({ copyableShare: 0.56, closedPositions: 40, turnoverPerDay: 3.3, tradedPerDayOverEquity: 0.46 })).toBe(true);
    expect(passesHoldGate({ copyableShare: 0.38, closedPositions: 40, turnoverPerDay: 0.1, tradedPerDayOverEquity: 0.1 })).toBe(false);
    expect(passesHoldGate({ copyableShare: null, closedPositions: 0, turnoverPerDay: 0.2, tradedPerDayOverEquity: 0.04 })).toBe(true);
    expect(passesHoldGate({ copyableShare: null, closedPositions: 0, turnoverPerDay: 3, tradedPerDayOverEquity: 0.5 })).toBe(false);
    expect(passesHoldGate({ copyableShare: null, closedPositions: 0, turnoverPerDay: null, tradedPerDayOverEquity: null })).toBe(false);
  });
});

describe("holdMeasures", () => {
  const fill = (coin: string, minutes: number, side: "B" | "A", sz: number, px: number, startPosition: number): HlFill =>
    ({ coin, oid: minutes, px: String(px), sz: String(sz), side, startPosition: String(startPosition), crossed: true, time: NOW - 10 * 24 * HOUR + minutes * 60_000 });

  test("weights closed positions by peak notional; a flip closes one and opens the next; turnover from traded notional", () => {
    const fills = [
      fill("BTC", 0, "B", 1, 100, 0), fill("BTC", 60, "B", 1, 100, 1), fill("BTC", 120, "A", 2, 100, 2), // 2 h, peak $200
      fill("ETH", 0, "A", 3, 100, 0), fill("ETH", 30, "B", 4, 100, -3), // 30 min short, peak $300, flips long $100
      fill("@107", 0, "B", 1000, 1, 0), // spot: ignored
    ];
    const m = holdMeasures(fills, 1_000, 0.5, NOW);
    expect(m.closedPositions).toBe(2);
    expect(m.copyableShare).toBeCloseTo(200 / 500);
    // Traded $1,100 over 30 days; ÷ $1,000 equity; ÷ 0.5 average leverage.
    expect(m.tradedPerDayOverEquity).toBeCloseTo(1_100 / 30 / 1_000);
    expect(m.turnoverPerDay).toBeCloseTo(1_100 / 30 / 1_000 / 0.5);
  });

  test("no fills: nothing closed and no turnover", () => {
    expect(holdMeasures([], 1_000, null, NOW)).toEqual({ copyableShare: null, closedPositions: 0, turnoverPerDay: 0, tradedPerDayOverEquity: 0 });
  });
});

describe("observe and transition (ROSTER.md §4)", () => {
  const flat = { equity: 1_000, positions: [] };
  const holding = { equity: 1_000, positions: [{ asset: "BTC", notional: 500 }] };

  test("counts flat runs once per new snapshot and resets when the wallet holds again; a missing entry changes nothing", () => {
    let s = observe(seat(), 600, flat);
    expect(s).toMatchObject({ flatRuns: 1, flatSince: 600_000, lastRunAt: 600 });
    expect(observe(s, 600, flat)).toBe(s); // the same run again
    s = observe(s, 1200, flat);
    expect(s).toMatchObject({ flatRuns: 2, flatSince: 600_000 });
    s = observe(s, 1800, holding);
    expect(s).toMatchObject({ flatRuns: 0, flatSince: null });
    expect(observe(s, 2400, undefined)).toBe(s);
  });

  test("seated: flat for 3 runs releases (exit)", () => {
    expect(transition(seat({ flatRuns: 2 }), NOW)).toBeNull();
    expect(transition(seat({ flatRuns: ROSTER.exitFlatRuns }), NOW)).toEqual({ to: "released", reason: "exit" });
  });

  test("probation: kept while briefly flat, released once idle 6 h, seated when tenure ends", () => {
    const p = seat({ state: "probation", minTenureUntil: NOW + 10 * HOUR, flatRuns: 20 });
    expect(transition({ ...p, flatSince: NOW - 5 * HOUR }, NOW)).toBeNull();
    expect(transition({ ...p, flatSince: NOW - 6 * HOUR }, NOW)).toEqual({ to: "released", reason: "idle" });
    expect(transition({ ...p, flatRuns: 0, minTenureUntil: NOW }, NOW)).toEqual({ to: "seated", reason: "tenure" });
  });

  test("winding down: released when no cap is left, at an exit, or after 48 h", () => {
    const w = seat({ state: "winding_down", caps: { BTC: 0.5 }, windDownUntil: NOW + HOUR });
    expect(transition(w, NOW)).toBeNull();
    expect(transition({ ...w, caps: {} }, NOW)).toEqual({ to: "released", reason: "wound down" });
    expect(transition({ ...w, flatRuns: 3 }, NOW)).toEqual({ to: "released", reason: "exit" });
    expect(transition({ ...w, windDownUntil: NOW }, NOW)).toEqual({ to: "released", reason: "wind-down timeout" });
  });

  test("winding-down caps start at today's leverage and only ever shrink; a closed or flipped perp drops out", () => {
    const caps = capsFrom({ equity: 1_000, positions: [{ asset: "BTC", notional: 500 }, { asset: "ETH", notional: -200 }, { asset: "SOL", notional: 100 }] });
    expect(caps).toEqual({ BTC: 0.5, ETH: -0.2, SOL: 0.1 });
    const next = ratchetCaps(caps, { equity: 1_000, positions: [{ asset: "BTC", notional: 800 }, { asset: "ETH", notional: -100 }, { asset: "SOL", notional: -50 }] });
    expect(next).toEqual({ BTC: 0.5, ETH: -0.1 }); // BTC increased: still 0.5; SOL flipped: gone
    expect(observe(seat({ state: "winding_down", caps }), 600, { equity: 1_000, positions: [] }).caps).toEqual({});
  });
});

describe("the 12-hourly seat review (owner: wind down, no panic selling)", () => {
  const v = (over: Partial<Verdict> = {}): Verdict => ({ address: addr(0), approved: true, riskReject: false, fit: 60, liquidatedAt: null, ...over });
  const probation = seat({ state: "probation", minTenureUntil: NOW + 10 * HOUR });

  test("warning signs wind down at any time, even in probation", () => {
    expect(reviewSeat(probation, v({ riskReject: true }), true, NOW, null).windDown).toBe("risk reject");
    expect(reviewSeat(probation, v({ liquidatedAt: probation.admittedAt + 1 }), true, NOW, null).windDown).toBe("liquidation");
    // A liquidation before admission isn't this seat's warning.
    expect(reviewSeat(probation, v({ liquidatedAt: probation.admittedAt - 1 }), true, NOW, null).windDown).toBeUndefined();
  });

  test("losing approval winds down only past tenure", () => {
    expect(reviewSeat(probation, v({ approved: false }), true, NOW, null).windDown).toBeUndefined();
    expect(reviewSeat(probation, undefined, true, NOW, null).windDown).toBeUndefined();
    expect(reviewSeat(seat(), v({ approved: false }), true, NOW, null).windDown).toBe("lost approval");
    expect(reviewSeat(seat(), undefined, true, NOW, null).windDown).toBe("lost approval"); // Score dropped it
  });

  test("off the qualified list at 2 consecutive reviews winds down a seated wallet", () => {
    const once = reviewSeat(seat(), v(), false, NOW, null);
    expect(once).toEqual({ unqualifiedReviews: 1 });
    expect(reviewSeat(seat({ unqualifiedReviews: 1 }), v(), false, NOW, null).windDown).toBe("off the qualified list");
    expect(reviewSeat(seat({ unqualifiedReviews: 1 }), v(), true, NOW, null)).toEqual({ unqualifiedReviews: 0 });
  });

  test("an approved seat's weight moves only past 5 points", () => {
    expect(reviewSeat(seat({ weightUnits: 90_000 }), v(), true, NOW, 140_000)).toEqual({ unqualifiedReviews: 0 });
    expect(reviewSeat(seat({ weightUnits: 90_000 }), v(), true, NOW, 140_001)).toEqual({ unqualifiedReviews: 0, weightUnits: 140_001 });
  });
});

describe("the 50% loss rule (owner: withdrawals don't count)", () => {
  test("a trading loss of half the equity at admission removes; a withdrawal never does", () => {
    const s = seat({ equityAtAdmission: 100_000, pnlAtAdmission: 10_000 });
    expect(lossBreached(s, -39_999)).toBe(false);
    expect(lossBreached(s, -40_000)).toBe(true);
    // Equity halved by a withdrawal, PnL unchanged.
    expect(lossBreached(s, 10_000)).toBe(false);
    expect(lossBreached(seat({ pnlAtAdmission: null }), -1e9)).toBe(false);
  });

  test("pnlAndEquity reads all-time PnL and the live day window's account value", () => {
    const portfolio = [
      ["day", { accountValueHistory: [[1, "900"], [2, "950.5"]], pnlHistory: [[1, "0"], [2, "5"]] }],
      ["allTime", { accountValueHistory: [[1, "800"]], pnlHistory: [[1, "-10"], [2, "120.25"]] }],
    ];
    expect(pnlAndEquity(portfolio)).toEqual({ pnl: 120.25, equity: 950.5 });
    expect(pnlAndEquity({})).toBeNull();
  });
});

describe("admissions (owner D3, D6, D8)", () => {
  test("seats are sized for 12–15 wallets (owner): 90% ÷ target × fit, with the AI's approvals above 12 raising the target", () => {
    const b = [bench(1, 90), bench(2, 60), bench(3, 30)];
    const active = [0, 4, 5, 6, 7].map((i) => seat({ address: addr(i), weightUnits: 100_000 }));
    expect(targetSeats(active, b)).toBe(12); // 8 approved wallets: still sized for 12, the rest cash
    const out = planAdmissions(admissionInput(active, b, { admittedLastHour: 0 }));
    // Target 12 → seat 75,000; mean fit 60 → modifiers 1.5, 1.0, 0.5. Two this hour (pace).
    expect(out.map((a) => [a.entry.address, a.weightUnits])).toEqual([[addr(1), 112_500], [addr(2), 75_000]]);
    expect(out[0].minTenureUntil).toBe(NOW + tenureMs(0.5));
    expect(targetSeats([], [])).toBe(ROSTER.targetSeatsMin);
    expect(targetSeats([], Array.from({ length: 13 }, (_, i) => bench(i, 50)))).toBe(13);
    expect(targetSeats([], Array.from({ length: 20 }, (_, i) => bench(i, 50)))).toBe(ROSTER.maxSeats);
  });

  test("pace: 2 an hour and 8 a day, except while fewer than 5 seats are filled", () => {
    const b = Array.from({ length: 8 }, (_, i) => bench(i + 10, 50));
    const five = [0, 1, 2, 3, 4].map((i) => seat({ address: addr(i), weightUnits: 50_000 }));
    expect(planAdmissions(admissionInput(five, b, { admittedLastHour: 2 }))).toHaveLength(0);
    expect(planAdmissions(admissionInput(five, b, { admittedLastHour: 1 }))).toHaveLength(1);
    expect(planAdmissions(admissionInput(five, b, { admittedLastDay: 8 }))).toHaveLength(0);
    // Bootstrap: 2 seats, the hour already used up, still fills to 5 before the pace applies.
    expect(planAdmissions(admissionInput(five.slice(0, 2), b, { admittedLastHour: 2 }))).toHaveLength(3);
  });

  test("skips seated, cooling, stale and non-copyable wallets; never fills past 90%", () => {
    const active = [0, 1, 2, 3, 4].map((i) => seat({ address: addr(i), weightUnits: 150_000 })); // 75% used
    const b = [bench(0, 99), bench(5, 90), bench(6, 80, { approvedAt: NOW - 13 * HOUR }), bench(7, 70, { passesHold: false }), bench(8, 60), bench(9, 50)];
    const out = planAdmissions(admissionInput(active, b, { cooling: new Set([addr(5)]) }));
    // Target 12 (seat 75,000); mean fit 74.75: addr(8) at 0.80×, addr(9) at 0.67×, within the 15% room.
    expect(out.map((a) => [a.entry.address, a.weightUnits])).toEqual([[addr(8), 60_200], [addr(9), 50_167]]);
    // With less than half a seat of room left, nothing more is admitted.
    expect(planAdmissions(admissionInput([...active, seat({ address: addr(20), weightUnits: 120_000 })], b))).toEqual([]);
  });

  test("implied turnover is Σ weight × traded per day ÷ equity, over seats that know it", () => {
    expect(impliedTurnover([seat({ weightUnits: 100_000, tradedPerDayOverEquity: 0.5 }), seat({ weightUnits: 200_000, tradedPerDayOverEquity: null })])).toBeCloseTo(0.05);
    expect(impliedTurnover([])).toBeNull();
  });
});

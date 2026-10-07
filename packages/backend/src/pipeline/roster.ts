// The per-wallet roster (docs/ingest/ROSTER.md): which wallets hold seats, for how long, and at
// what fixed weight. Pure rules, no I/O; the pipeline's roster step (index.ts) applies them every
// 10 minutes and freezes the seats into the configuration the executor copies.
import type { HoldMeasures } from "./evidence";

const HOUR = 3_600_000;

// Owner decisions, 2026-10-07 (ROSTER.md §10).
export const ROSTER = {
  minSeats: 5, // the freeze's floor
  targetSeatsMin: 12, // owner: aim for 12–15 wallets; seats are sized for at least 12
  maxSeats: 15,
  tenureMinHours: 12,
  tenureMaxHours: 72,
  tenureUnknownHours: 24, // a wallet whose book turnover is unknown (e.g. seeded seats)
  tenureLifetimes: 3, // tenure = 3 book lifetimes (1 ÷ turnover per day)
  idleReleaseHours: 6, // in probation: flat this long releases the seat
  exitFlatRuns: 3, // after probation: flat this many runs releases the seat (as our closes, #63)
  windDownHours: 48,
  admissionsPerHour: 2,
  admissionsPerDay: 8,
  cooldownHours: 24, // before a released wallet can be admitted again
  approvalFreshHours: 12,
  removeAtLoss: 0.5, // trading loss since admission ÷ equity at admission; withdrawals don't count
  copyableShareMin: 0.5,
  turnoverMaxWithoutCloses: 1, // per day, for wallets with no closed position to measure
  fitModifier: [0.5, 1.5] as const,
} as const;

export type SeatState = "probation" | "seated" | "winding_down" | "released" | "removed";
export const ACTIVE: readonly SeatState[] = ["probation", "seated", "winding_down"];

export type Seat = {
  address: string;
  state: SeatState;
  weightUnits: number; // of 1e6
  fit: number | null;
  turnoverPerDay: number | null;
  tradedPerDayOverEquity: number | null;
  admittedAt: number;
  minTenureUntil: number;
  flatSince: number | null;
  flatRuns: number;
  lastRunAt: number | null; // the last snapshot (unix seconds) observed
  equityAtAdmission: number | null;
  pnlAtAdmission: number | null;
  windDownUntil: number | null;
  // Winding down: the signed leverage (notional ÷ equity) per perp we still follow, ratcheted down.
  caps: Record<string, number> | null;
  averageLeverage?: number | null; // 30-day average gross leverage (the snapshot's normalization)
  reviewedAt: number | null; // the last 12-hourly seat review
  unqualifiedReviews: number; // consecutive seat reviews that found it off the qualified list
};

// An AI-approved candidate from the latest review (selection_runs.review.bench).
export type BenchEntry = HoldMeasures & {
  address: string;
  fit: number;
  approvedAt: number;
  passesHold: boolean;
  // 30-day average gross leverage (evidence.ts averageLeverage): the snapshot's normalization.
  averageLeverage?: number | null;
};

export type Transition = { to: SeatState; reason: string };

// A wallet's verdict from a review (selection_runs.review -> 'verdicts').
export type Verdict = { address: string; approved: boolean; riskReject: boolean; fit: number; liquidatedAt: number | null };

export const SEAT_REVIEW_HOURS = 12;
export const WEIGHT_REFRESH_UNITS = 50_000; // a re-review moves a seat's weight only past 5 points

// A seat review's outcome for one seat (ROSTER.md §4.4–4.5): wind down on a warning sign at any time
// (Risk reject, liquidation since admission) or, past tenure, on losing approval (not approved, or
// off the qualified list at 2 consecutive reviews); otherwise maybe a new weight. Never a sale.
export const reviewSeat = (
  seat: Seat,
  verdict: Verdict | undefined,
  qualified: boolean,
  nowMs: number,
  refreshedUnits: number | null,
): { windDown?: string; unqualifiedReviews: number; weightUnits?: number } => {
  const unqualifiedReviews = qualified ? 0 : seat.unqualifiedReviews + 1;
  if (verdict?.riskReject) return { windDown: "risk reject", unqualifiedReviews };
  if (verdict?.liquidatedAt != null && verdict.liquidatedAt >= seat.admittedAt) return { windDown: "liquidation", unqualifiedReviews };
  const pastTenure = seat.state === "seated" || nowMs >= seat.minTenureUntil;
  if (pastTenure && !verdict?.approved) return { windDown: "lost approval", unqualifiedReviews };
  if (pastTenure && unqualifiedReviews >= 2) return { windDown: "off the qualified list", unqualifiedReviews };
  if (verdict?.approved && refreshedUnits !== null && Math.abs(refreshedUnits - seat.weightUnits) > WEIGHT_REFRESH_UNITS) return { unqualifiedReviews, weightUnits: refreshedUnits };
  return { unqualifiedReviews };
};

// Minimum tenure: 3 book lifetimes, within 12–72 h (owner D1).
export const tenureMs = (turnoverPerDay: number | null): number => {
  if (turnoverPerDay === null || !Number.isFinite(turnoverPerDay)) return ROSTER.tenureUnknownHours * HOUR;
  const hours = turnoverPerDay > 0 ? (ROSTER.tenureLifetimes / turnoverPerDay) * 24 : Infinity;
  return Math.min(Math.max(hours, ROSTER.tenureMinHours), ROSTER.tenureMaxHours) * HOUR;
};

// Copyable from a 10-minute loop (ROSTER.md §5.3): at least half the closed notional held ≥ 90 min;
// a wallet with no closed position to measure passes if its book turns over at most once a day.
export const passesHoldGate = (m: HoldMeasures): boolean => {
  if (m.closedPositions > 0 && m.copyableShare !== null) return m.copyableShare >= ROSTER.copyableShareMin;
  return m.turnoverPerDay !== null && m.turnoverPerDay <= ROSTER.turnoverMaxWithoutCloses;
};

export type SnapshotEntry = { equity: number; positions: { asset: string; notional: number }[] };

// Updates flat tracking (and a winding-down seat's caps) from a run's snapshot. A seat missing from
// it (admitted after the snapshot was built) or an already observed run is left as it is.
export const observe = (seat: Seat, runAt: number, entry: SnapshotEntry | undefined): Seat => {
  if (!entry || (seat.lastRunAt !== null && runAt <= seat.lastRunAt)) return seat;
  const held = entry.positions.filter((p) => p.notional !== 0);
  const next: Seat = { ...seat, lastRunAt: runAt };
  if (held.length === 0) {
    next.flatRuns = seat.flatRuns + 1;
    next.flatSince = seat.flatSince ?? runAt * 1000;
  } else {
    next.flatRuns = 0;
    next.flatSince = null;
  }
  if (seat.state === "winding_down" && seat.caps) next.caps = ratchetCaps(seat.caps, entry);
  return next;
};

// Never up: each cap shrinks to the leverage the wallet still holds in that perp, same sign; a perp
// it closed or flipped drops out.
export const ratchetCaps = (caps: Record<string, number>, entry: SnapshotEntry): Record<string, number> => {
  const out: Record<string, number> = {};
  for (const [asset, cap] of Object.entries(caps)) {
    const notional = entry.positions.find((p) => p.asset === asset)?.notional ?? 0;
    const leverage = entry.equity > 0 ? notional / entry.equity : 0;
    if (leverage !== 0 && Math.sign(leverage) === Math.sign(cap)) out[asset] = Math.sign(cap) * Math.min(Math.abs(cap), Math.abs(leverage));
  }
  return out;
};

// Caps when winding down starts: the wallet's leverage per perp now.
export const capsFrom = (entry: SnapshotEntry | undefined): Record<string, number> => {
  const out: Record<string, number> = {};
  if (!entry || !(entry.equity > 0)) return out;
  for (const p of entry.positions) if (p.notional !== 0) out[p.asset] = p.notional / entry.equity;
  return out;
};

// A seat's next state from time and flat tracking, or null to stay (owner D2, D4; ROSTER.md §4).
export const transition = (seat: Seat, nowMs: number): Transition | null => {
  const flatFor = seat.flatSince === null ? 0 : nowMs - seat.flatSince;
  switch (seat.state) {
    case "probation":
      if (seat.flatSince !== null && flatFor >= ROSTER.idleReleaseHours * HOUR) return { to: "released", reason: "idle" };
      if (nowMs >= seat.minTenureUntil) return { to: "seated", reason: "tenure" };
      return null;
    case "seated":
      return seat.flatRuns >= ROSTER.exitFlatRuns ? { to: "released", reason: "exit" } : null;
    case "winding_down":
      if (seat.caps && Object.keys(seat.caps).length === 0) return { to: "released", reason: "wound down" };
      if (seat.flatRuns >= ROSTER.exitFlatRuns) return { to: "released", reason: "exit" };
      if (seat.windDownUntil !== null && nowMs >= seat.windDownUntil) return { to: "released", reason: "wind-down timeout" };
      return null;
    default:
      return null;
  }
};

// The one immediate removal (owner): a trading loss of 50% since admission. PnL, not equity, so
// deposits and withdrawals never count.
export const lossBreached = (seat: Seat, pnlNow: number): boolean =>
  seat.equityAtAdmission !== null &&
  seat.equityAtAdmission > 0 &&
  seat.pnlAtAdmission !== null &&
  (seat.pnlAtAdmission - pnlNow) / seat.equityAtAdmission >= ROSTER.removeAtLoss;

export type Admission = { entry: BenchEntry; weightUnits: number; minTenureUntil: number };

export type AdmissionInput = {
  active: Seat[];
  bench: BenchEntry[];
  // Released or removed within the cooldown, by address.
  cooling: ReadonlySet<string>;
  admittedLastHour: number;
  admittedLastDay: number;
  nowMs: number;
  cashBuffer: number;
  maxSourceWeight: number;
};

// The seat count to size seats for: every wallet the AI currently approves (the fresh bench that
// passes the hold gate, plus seats not winding down), within the owner's 12–15 target. With fewer
// approved wallets, seats stay sized for 12 and the rest is cash (owner, 2026-10-07).
export const targetSeats = (active: Seat[], approved: BenchEntry[]): number => {
  const wallets = new Set([...approved.map((b) => b.address), ...active.filter((s) => s.state !== "winding_down").map((s) => s.address)]);
  return Math.min(Math.max(wallets.size, ROSTER.targetSeatsMin), ROSTER.maxSeats);
};

// Which bench wallets to seat now, best fit first, each at a fixed weight: 90% ÷ the target count ×
// its fit relative to the approved mean (0.5–1.5), within the per-source cap and the room left
// under 90%. Pace: 2 an hour and 8 a day, except while fewer than 5 seats are filled.
export const planAdmissions = (input: AdmissionInput): Admission[] => {
  const { active, nowMs } = input;
  const fresh = input.bench.filter((b) => nowMs - b.approvedAt <= ROSTER.approvalFreshHours * HOUR && b.passesHold);
  const target = targetSeats(active, fresh);
  const seated = new Set(active.map((s) => s.address));
  const candidates = fresh
    .filter((b) => !seated.has(b.address) && !input.cooling.has(b.address))
    .sort((a, b) => b.fit - a.fit || (a.address < b.address ? -1 : 1));
  const meanFit = fresh.length ? fresh.reduce((sum, b) => sum + b.fit, 0) / fresh.length : 0;
  const seatUnits = ((1 - input.cashBuffer) / target) * 1e6;
  const capUnits = Math.floor(input.maxSourceWeight * 1e6);
  let room = Math.floor((1 - input.cashBuffer) * 1e6) - active.reduce((sum, s) => sum + s.weightUnits, 0);
  let open = target - active.filter((s) => s.state !== "winding_down").length;
  let filled = active.length;
  let hour = input.admittedLastHour;
  let day = input.admittedLastDay;
  const out: Admission[] = [];
  for (const entry of candidates) {
    if (open <= 0) break;
    const bootstrap = filled < ROSTER.minSeats;
    if (!bootstrap && (hour >= ROSTER.admissionsPerHour || day >= ROSTER.admissionsPerDay)) break;
    const modifier = meanFit > 0 ? Math.min(Math.max(entry.fit / meanFit, ROSTER.fitModifier[0]), ROSTER.fitModifier[1]) : 1;
    const weightUnits = Math.min(Math.floor(seatUnits * modifier), capUnits, room);
    if (weightUnits < seatUnits / 2) break; // under half a seat of room: wait for weight to free up
    out.push({ entry, weightUnits, minTenureUntil: nowMs + tenureMs(entry.turnoverPerDay) });
    room -= weightUnits;
    open--;
    filled++;
    hour++;
    day++;
  }
  return out;
};

// The roster's implied copy turnover (× our equity per day, before our bands): monitored, never
// enforced (owner).
export const impliedTurnover = (active: Seat[]): number | null => {
  const known = active.filter((s) => s.tradedPerDayOverEquity !== null);
  return known.length ? known.reduce((sum, s) => sum + (s.weightUnits / 1e6) * s.tradedPerDayOverEquity!, 0) : null;
};

// Hyperliquid's all-time PnL and live account value (the `day` window's last point, as the
// snapshot's equity; README §4.7) from a `portfolio` response.
export const pnlAndEquity = (portfolio: unknown): { pnl: number; equity: number } | null => {
  if (!Array.isArray(portfolio)) return null;
  type Window = { pnlHistory?: [number, string][]; accountValueHistory?: [number, string][] };
  const windows = new Map(portfolio as [string, Window][]);
  const pnl = Number(windows.get("allTime")?.pnlHistory?.at(-1)?.[1]);
  const equity = Number((windows.get("day") ?? windows.get("allTime"))?.accountValueHistory?.at(-1)?.[1]);
  return Number.isFinite(pnl) && Number.isFinite(equity) ? { pnl, equity } : null;
};

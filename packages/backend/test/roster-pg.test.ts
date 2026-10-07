// The roster step against a real Postgres (TEST_DATABASE_URL; see pg-store.test.ts), with Hyperliquid's
// portfolio reads mocked: seed from the active configuration → fill an open seat from the bench →
// release a wallet that exited → remove one at a 50% trading loss → freeze and activate.
import { describe, expect, test } from "bun:test";
import { SQL } from "bun";
import { Pipeline, reviewPolicy, seatLeverage, windDownCaps } from "../src/pipeline";
import { PacedInfo } from "../src/pipeline/hl";
import { checkFrozenConfiguration, type FrozenConfiguration } from "../../shared/frozen";
import { keccakUtf8 } from "../src/snapshot";
import fixture from "../fixtures/frozen-configuration.json";

const url = process.env.TEST_DATABASE_URL;
const HOUR = 3_600_000;
const T0 = 1_791_400_200; // a :x0 run (unix seconds)
const migration = (name: string) => Bun.file(new URL(`../../../supabase/migrations/${name}`, import.meta.url)).text();
const configuration = fixture as unknown as FrozenConfiguration;
const seeded = configuration.sources.map((s) => s.sourceAddress.toLowerCase());
const newcomer = (i: number) => `0x${"9".repeat(39)}${i}`;

describe.skipIf(!url)("Roster on Postgres", async () => {
  if (!url) return;
  const sql = new SQL(url, { prepare: process.env.TEST_PG_PREPARE === "1" });
  await sql.unsafe("drop table if exists roster_events, roster_seats, configurations, selection_runs, pipeline_accounts, run_snapshots cascade");
  for (const name of ["20261006120000_mirror.sql", "20261007120000_pipeline.sql", "20261007150000_pipeline_qualified.sql", "20261007160000_pipeline_primary.sql", "20261008020000_roster.sql", "20261008020000_roster.sql", "20261008030000_roster_leverage.sql", "20261008030000_roster_leverage.sql"]) {
    await sql.unsafe(await migration(name));
  }
  await sql`insert into configurations (hash, configuration, status, activated_at)
    values (${configuration.configurationHash}, ${JSON.stringify(configuration)}::text::jsonb, 'active', now())`;

  // Portfolio per wallet: all-time PnL and live equity.
  const pnl = new Map<string, number>();
  const info = (async (_: string, init: RequestInit) => {
    const { user } = JSON.parse(String(init.body)) as { user: string };
    const p = pnl.get(user) ?? 1_000;
    return Response.json([["day", { accountValueHistory: [[1, "100000"]], pnlHistory: [[1, "0"]] }], ["allTime", { accountValueHistory: [[1, "100000"]], pnlHistory: [[1, String(p)]] }]]);
  }) as unknown as typeof fetch;
  const at = (runAt: number) =>
    new Pipeline({ sql, account: configuration.account, policy: reviewPolicy(configuration), log: () => {}, now: () => runAt * 1000 + 6 * 60_000, info: (perMinute) => new PacedInfo(perMinute, info, async () => {}) });

  // A run's snapshot: every seeded wallet holds BTC, except those listed as flat.
  const snapshot = async (runAt: number, flat: string[], extra: string[] = []) => {
    const sources = [...seeded, ...extra].map((address) => ({
      address, equityE6: "100000000000", positions: flat.includes(address) ? [] : [{ asset: "BTC", notionalE6: "50000000000" }],
    }));
    const body = JSON.stringify({ snapshotId: `snap-${runAt}`, runAt, startedAt: runAt, takenAt: runAt, configuration, eligibleAssets: ["BTC"], sources });
    await sql`insert into run_snapshots (run_at, snapshot_hash, configuration_hash, body) values (${runAt}, ${keccakUtf8(body)}, ${configuration.configurationHash}, ${body})`;
  };
  const bench = async (entries: { address: string; fit: number; passesHold?: boolean }[], approvedAt: number) => {
    const rows = entries.map((e) => ({ address: e.address, fit: e.fit, approvedAt, copyableShare: 0.7, closedPositions: 12, turnoverPerDay: 0.5, tradedPerDayOverEquity: 0.1, passesHold: e.passesHold ?? true, averageLeverage: 0.4 }));
    await sql`insert into selection_runs (started_at, finished_at, status, review)
      values (${new Date(approvedAt).toISOString()}, ${new Date(approvedAt).toISOString()}, 'benched', ${JSON.stringify({ bench: rows, receiptHash: `0x${"ab".repeat(32)}` })}::text::jsonb)`;
  };
  const seats = async () => (await sql`select address, state, weight_units, release_reason from roster_seats order by id`) as { address: string; state: string; weight_units: number; release_reason: string | null }[];
  const active = async () => (await sql`select configuration from configurations where status = 'active'`)[0].configuration as FrozenConfiguration;

  test("seeds the active configuration's wallets, seated, and fills an open seat from the bench at a fixed weight", async () => {
    await snapshot(T0, [seeded[0]]);
    await bench([{ address: newcomer(1), fit: 80 }, { address: newcomer(2), fit: 40 }, { address: newcomer(3), fit: 90, passesHold: false }], T0 * 1000);
    const result = await at(T0).roster();
    // Target 9 (2 copyable approvals + 7 seats) → seat 100,000; fit 80 of mean 60 → 133,333; then too little room for the next.
    expect(result.status).toBe("activated");
    expect(result.changes.filter((c) => c.startsWith("seeded"))).toHaveLength(7);
    expect(result.changes.filter((c) => c.startsWith("admitted"))).toEqual([`admitted ${newcomer(1)} (open seat)`]);
    const rows = await seats();
    expect(rows.find((r) => r.address === newcomer(1))).toMatchObject({ state: "probation", weight_units: 133_333 });
    // Its 30-day average leverage is kept for the snapshot's normalization; seeded seats get theirs at the seat review.
    expect((await seatLeverage(sql)).find((l) => l.address === newcomer(1))).toEqual({ address: newcomer(1), averageLeverage: 0.4 });
    const config = await active();
    checkFrozenConfiguration(keccakUtf8, config, config.configurationHash, T0 * 1000 + HOUR);
    expect(config.sources.map((s) => s.sourceAddress)).toContain(newcomer(1));
    expect(config.cashUnits).toBe(1e6 - 750_000 - 133_333);
    // Unchanged next step: the configuration is kept.
    expect((await at(T0).roster()).status).toBe("kept");
  });

  test("a change of policy (the 5× gross cap) re-freezes the same seats under it", async () => {
    const policy = { ...reviewPolicy(configuration), maxGrossLeverage: 5 };
    const pipeline = new Pipeline({ sql, account: configuration.account, policy, log: () => {}, now: () => T0 * 1000 + 6 * 60_000, info: (perMinute) => new PacedInfo(perMinute, info, async () => {}) });
    const before = await active();
    const result = await pipeline.roster();
    expect(result.status).toBe("activated");
    const after = await active();
    expect(after.policy.maxGrossLeverage).toBe(5);
    expect(after.sources).toEqual(before.sources);
    expect((await pipeline.roster()).status).toBe("kept");
    // Back to the fixture's policy for the steps below.
    expect((await at(T0).roster()).status).toBe("activated");
  });

  test("a seated wallet flat for 3 runs releases its seat; the replacement waits for weight to free up, then fills it", async () => {
    await snapshot(T0 + 600, [seeded[0]], [newcomer(1)]);
    expect((await at(T0 + 600).roster()).changes).toEqual([]); // flat 2 runs
    await snapshot(T0 + 1200, [seeded[0]], [newcomer(1)]);
    const result = await at(T0 + 1200).roster();
    expect(result.changes[0]).toBe(`released ${seeded[0]} (exit)`);
    // Its 150,000 frees room: newcomer(2) is admitted the same step (bench still fresh).
    expect(result.changes).toContain(`admitted ${newcomer(2)} (open seat)`);
    expect(result.status).toBe("activated");
    const config = await active();
    expect(config.sources.map((s) => s.sourceAddress)).not.toContain(seeded[0]);
    expect((await seats()).find((r) => r.address === seeded[0])).toMatchObject({ state: "released", release_reason: "exit" });
  });

  test("a released wallet cools down for 24 h and isn't re-admitted from the bench", async () => {
    await bench([{ address: seeded[0], fit: 99 }], (T0 + 1800) * 1000);
    await snapshot(T0 + 1800, [], [newcomer(1), newcomer(2)]);
    const result = await at(T0 + 1800).roster();
    expect(result.changes.some((c) => c.includes(`admitted ${seeded[0]}`))).toBe(false);
  });

  test("a 50% trading loss since admission removes a seat; a withdrawal (equity down, PnL flat) does not", async () => {
    pnl.set(seeded[1], 1_000 - 50_000); // −$50k PnL on $100k equity at admission
    await snapshot(T0 + 2400, [], [newcomer(1), newcomer(2)]);
    const result = await at(T0 + 2400).roster();
    expect(result.changes).toContain(`removed ${seeded[1]} (trading loss)`);
    expect((await seats()).find((r) => r.address === seeded[2])!.state).toBe("seated");
    const [event] = await sql`select detail from roster_events where kind = 'removed'`;
    expect(event.detail).toMatchObject({ reason: "trading loss", pnlNow: -49_000, pnlAtAdmission: 1_000, equityAtAdmission: 100_000 });
  });

  test("status shows the seats, recent events and the implied turnover", async () => {
    const { roster } = await at(T0 + 2400).status();
    expect(roster!.seats.length).toBeGreaterThanOrEqual(5);
    expect(roster!.events[0]).toHaveProperty("kind");
    expect(roster!.impliedTurnover).toBeGreaterThan(0);
  });

  test("turning high-frequency winds a seat down with caps from the snapshot; caps ratchet down and release it once nothing is left", async () => {
    const target = seeded[3];
    await sql`insert into pipeline_accounts (address, source, kind, account_value, listed_at, orders_per_day)
      values (${target}, 'leaderboard', 'trader', 100000, now(), 500)`;
    await sql`update roster_seats set reviewed_at = now() where state in ('probation', 'seated')`; // no seat review this step
    const result = await at(T0 + 2400).roster();
    expect(result.changes).toContain(`winding_down ${target} (high-frequency)`);
    const [row] = await sql`select state, caps, wind_down_until from roster_seats where address = ${target} and state = 'winding_down'`;
    expect(row.caps).toEqual({ BTC: 0.5 }); // $50k BTC on $100k equity
    expect(await windDownCaps(sql)).toEqual([{ address: target, caps: [{ asset: "BTC", leverageE9: "500000000" }] }]);
    // The wallet closes BTC: the cap drops out and the seat is released (wound down).
    await snapshot(T0 + 3000, [target], [newcomer(1), newcomer(2)]);
    const next = await at(T0 + 3000).roster();
    expect(next.changes).toContain(`released ${target} (wound down)`);
  });

  test("a failing seat review is retried after 30 minutes, not every step, and never blocks the picks", async () => {
    await sql`update roster_seats set reviewed_at = null where state in ('probation', 'seated')`;
    const before = (await sql`select count(*)::int as n from selection_runs where (finalists ->> 'scope') = 'seats'`)[0].n;
    // Over 30 minutes after the last failed one: one new attempt (no OpenAI key: it fails), then none.
    await at(T0 + 5400).roster();
    await at(T0 + 5400).roster();
    const runs = await sql`select status from selection_runs where (finalists ->> 'scope') = 'seats'`;
    expect(runs.length).toBe(before + 1);
    expect(runs.every((r: { status: string }) => r.status === "failed")).toBe(true);
  });

  test("probation: briefly flat is kept, idle 6 h releases", async () => {
    const [p] = await sql`select address from roster_seats where state = 'probation' order by admitted_at limit 1`;
    await sql`update roster_seats set flat_since = ${new Date((T0 + 2400) * 1000 - 6 * HOUR).toISOString()}, flat_runs = 36, min_tenure_until = now() + interval '1 day' where address = ${p.address} and state = 'probation'`;
    const result = await at(T0 + 2400).roster();
    expect(result.changes).toContain(`released ${p.address} (idle)`);
  });
});

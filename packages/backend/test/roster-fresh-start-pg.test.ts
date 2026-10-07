// The roster's fresh start (ROSTER.md §4.6) against a real Postgres (TEST_DATABASE_URL; see
// pg-store.test.ts), with Hyperliquid's portfolio reads mocked: wait for 5 approvals across reviews →
// release every old seat → fill from the bench → activate → archive and restart the paper books, once.
import { describe, expect, test } from "bun:test";
import { SQL } from "bun";
import { Pipeline, reviewPolicy } from "../src/pipeline";
import { PacedInfo } from "../src/pipeline/hl";
import { checkFrozenConfiguration, type FrozenConfiguration } from "../../shared/frozen";
import { keccakUtf8 } from "../src/snapshot";
import fixture from "../fixtures/frozen-configuration.json";

const url = process.env.TEST_DATABASE_URL;
const T0 = 1_791_400_200; // a :x0 run (unix seconds)
const migration = (name: string) => Bun.file(new URL(`../../../supabase/migrations/${name}`, import.meta.url)).text();
const configuration = fixture as unknown as FrozenConfiguration;
const seeded = configuration.sources.map((s) => s.sourceAddress.toLowerCase());
const newcomer = (i: number) => `0x${"8".repeat(39)}${i}`;

describe.skipIf(!url)("Roster fresh start on Postgres", async () => {
  if (!url) return;
  const sql = new SQL(url, { prepare: process.env.TEST_PG_PREPARE === "1" });
  await sql.unsafe("drop table if exists roster_events, roster_seats, configurations, selection_runs, pipeline_accounts, run_snapshots, paper_state, paper_points, paper_state_archive, paper_points_archive, pipeline_controls cascade");
  for (const name of ["20261006120000_mirror.sql", "20261007120000_pipeline.sql", "20261007150000_pipeline_qualified.sql", "20261007160000_pipeline_primary.sql", "20261008020000_roster.sql", "20261008030000_roster_leverage.sql", "20261008050000_fresh_start.sql", "20261008050000_fresh_start.sql"]) {
    await sql.unsafe(await migration(name));
  }
  await sql`insert into configurations (hash, configuration, status, activated_at)
    values (${configuration.configurationHash}, ${JSON.stringify(configuration)}::text::jsonb, 'active', now())`;

  const info = (async () =>
    Response.json([["allTime", { accountValueHistory: [[1, "100000"]], pnlHistory: [[1, "1000"]] }]])) as unknown as typeof fetch;
  const at = (runAt: number) =>
    new Pipeline({ sql, account: configuration.account, policy: reviewPolicy(configuration), log: () => {}, now: () => runAt * 1000 + 6 * 60_000, info: (perMinute) => new PacedInfo(perMinute, info, async () => {}) });
  // A review of the picks: the wallets it reviewed (verdicts) and the ones it approved (bench).
  const review = async (startedAt: number, reviewed: string[], approved: { address: string; fit: number }[]) => {
    const bench = approved.map((e) => ({ address: e.address, fit: e.fit, approvedAt: startedAt * 1000, copyableShare: 0.7, closedPositions: 12, turnoverPerDay: 0.5, tradedPerDayOverEquity: 0.1, passesHold: true, averageLeverage: 0.4 }));
    const verdicts = reviewed.map((address) => ({ address, approved: approved.some((a) => a.address === address), riskReject: false, fit: 50, liquidatedAt: null }));
    await sql`insert into selection_runs (started_at, finished_at, status, review)
      values (${new Date(startedAt * 1000).toISOString()}, ${new Date(startedAt * 1000).toISOString()}, 'benched', ${JSON.stringify({ bench, verdicts, receiptHash: `0x${"cd".repeat(32)}` })}::text::jsonb)`;
  };
  const active = async () => (await sql`select configuration from configurations where status = 'active'`)[0].configuration as FrozenConfiguration;
  const paper = async () => ({
    state: (await sql`select count(*)::int as n from paper_state`)[0].n as number,
    points: (await sql`select count(*)::int as n from paper_points`)[0].n as number,
    archivedPoints: (await sql`select count(*)::int as n from paper_points_archive`)[0].n as number,
  });

  test("seeds the old configuration's wallets; nothing changes without a request", async () => {
    await sql`update roster_seats set reviewed_at = now()`; // no seat reviews in these tests
    expect((await at(T0).roster()).status).toBe("kept");
    await sql`update roster_seats set reviewed_at = now()`;
    await sql`insert into paper_state (id, state, last_run_at) values (1, '{"books":[]}'::jsonb, ${T0})`;
    await sql`insert into paper_points (book_id, t, equity_usd) values ('aggressive', ${T0}, 100000), ('balanced', ${T0}, 100000)`;
  });

  test("a fresh start waits until 5 approved wallets are on the bench", async () => {
    await review(T0 + 600, [newcomer(1), newcomer(2), newcomer(3), newcomer(6)], [
      { address: newcomer(1), fit: 70 }, { address: newcomer(2), fit: 65 }, { address: newcomer(3), fit: 60 }, { address: newcomer(6), fit: 90 },
    ]);
    await sql`update pipeline_controls set fresh_start_requested_at = ${new Date((T0 + 700) * 1000).toISOString()} where id = 1`;
    // 4 approved (newcomer 6 is approved here; the next review takes it off).
    const result = await at(T0 + 1200).roster();
    expect(result.changes.some((c) => c.startsWith("released"))).toBe(false);
    expect((await active()).sources.map((s) => s.sourceAddress).sort()).toEqual([...seeded].sort());
  });

  test("with 5 approved across reviews: every old seat is released, the bench fills 5 seats, the paper books restart", async () => {
    // The later review approves newcomers 4, 5 and an old seat's wallet, and doesn't approve newcomer 6.
    await review(T0 + 1300, [newcomer(4), newcomer(5), newcomer(6), seeded[0]], [
      { address: newcomer(4), fit: 55 }, { address: newcomer(5), fit: 50 }, { address: seeded[0], fit: 95 },
    ]);
    const result = await at(T0 + 1800).roster();
    expect(result.status).toBe("activated");
    expect(result.changes.filter((c) => c.endsWith("(fresh start)")).sort()).toEqual(seeded.map((a) => `released ${a} (fresh start)`).sort());
    // 5 at once (below the freeze's minimum the pace limit doesn't apply), best fit first. The old
    // seat's wallet is approved again and isn't cooling down; newcomer 6 lost its approval.
    const admitted = result.changes.filter((c) => c.startsWith("admitted")).map((c) => c.split(" ")[1]);
    expect(admitted).toEqual([seeded[0], newcomer(1), newcomer(2), newcomer(3), newcomer(4)]);
    const config = await active();
    checkFrozenConfiguration(keccakUtf8, config, config.configurationHash, (T0 + 1800) * 1000 + 3_600_000);
    expect(config.sources.map((s) => s.sourceAddress).sort()).toEqual([...admitted].sort());
    // Paper history archived; the books restart at the next snapshot.
    expect(await paper()).toEqual({ state: 0, points: 0, archivedPoints: 2 });
    const [control] = await sql`select fresh_start_done_at from pipeline_controls where id = 1`;
    expect(control.fresh_start_done_at).not.toBeNull();
  });

  test("done once: later steps keep the new seats and don't archive the paper books again", async () => {
    await sql`update roster_seats set reviewed_at = now() where state in ('probation', 'seated')`;
    await sql`insert into paper_points (book_id, t, equity_usd) values ('aggressive', ${T0 + 1800}, 100000)`;
    const result = await at(T0 + 2400).roster();
    expect(result.changes.some((c) => c.includes("fresh start"))).toBe(false);
    expect((await paper()).points).toBe(1);
    expect((await active()).sources.map((s) => s.sourceAddress)).toContain(seeded[0]);
  });
});

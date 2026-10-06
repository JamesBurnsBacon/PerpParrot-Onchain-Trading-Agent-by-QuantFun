import { describe, expect, test } from "bun:test";
import { buildScoreInputs, readScoreSnapshot, type ScoreSnapshot } from "../src/ingest/score-loader";
import { scoreCandidates } from "../src/score";
import { SupabaseRemote, PROJECT_URL } from "../src/ingest/supabase";
import type { DbRow, Table } from "../src/ingest/sync-snapshot";

const base = 1700000000000;
const day = 86400000;
const address = (n: number) => `0x${n.toString(16).padStart(40, "0")}`;
const stamp = (days: number) => new Date(base + days * day).toISOString();
const payload = (end: number, offset = 500) => ["month", "allTime"].map(name => {
  const start = name === "month" ? Math.max(0, end - 30) : 0;
  const days = Array.from({ length: end - start + 1 }, (_, i) => start + i);
  return [name, {
    accountValueHistory: days.map(i => [base + i * day, String(10000 + 10 * i)]),
    pnlHistory: days.map(i => [base + i * day, String(name === "month" ? (i - start) * 10 : offset + i * 10)]), vlm: "1000",
  }];
});
function snapshot(id: string, end: number): ScoreSnapshot {
  const candidate = {
    address: address(1), accountValueOrTvlUsd: "25000", valueSource: "hypercore-vault-tvl",
    sources: ["hypercore-vault-list"], name: null, knownHypercoreVault: true, leaderAddress: address(2),
  };
  return {
    run: { run_id: id, sync_status: "complete", candidate_count: 1, portfolio_count: 1,
      manifest: { runId: id, status: "complete", startedAt: stamp(end + .1), finishedAt: stamp(end + .3) } },
    candidateRows: [{ run_id: id, address: address(1), account_value_or_tvl_usd: "25000", kind: "hypercore-vault", shortlisted: true, candidate }],
    portfolioRows: [{ run_id: id, address: address(1), portfolio: payload(end), record: {
      address: address(1), classification: { kind: "hypercore-vault", evidence: "vault-list" },
      classificationError: null, portfolioError: null,
      portfolio: { path: "p.json", sha256: "a".repeat(64), fetchedAt: stamp(end + .2), windows: null },
    } }],
  };
}
function record(s: ScoreSnapshot) { return s.portfolioRows[0].record as Record<string, any>; }
function candidate(s: ScoreSnapshot) { return s.candidateRows[0].candidate as Record<string, any>; }
const fills = (count: number) => Array.from({ length: count }, (_, oid) => ({ coin: "BTC", oid, sz: "1", time: base + 33 * day }));

describe("stored ingest -> Score contract", () => {
  test("maps TVL, kind, open vault, links and raw decimal windows; only preview permits unknown fills", () => {
    const loaded = buildScoreInputs(snapshot("current", 34));
    expect(loaded.counts).toEqual({ selected: 1, loaded: 1, omitted: 0, unknownTradeCount: 1, withHistory: 0 });
    expect(loaded.issues).toEqual([]);
    expect(loaded.inputs[0]).toMatchObject({ accountValue: 25000, kind: "hypercore-vault", closed: false,
      tradeCount: null, links: [address(2)], history: null });
    expect(loaded.inputs[0].month!.pnlHistory[0][1]).toBe(0);
    expect(scoreCandidates(loaded.inputs).finalists).toHaveLength(0);
    expect(scoreCandidates(loaded.inputs, { allowUnknown: ["minTrades"] }).finalists).toEqual([address(1)]);
  });
  test("distinct past orders establish the threshold without inventing a lifetime count", () => {
    const s = snapshot("current", 34);
    expect(buildScoreInputs(s, [], new Map([[address(1), fills(9)]])).inputs[0].tradeCount).toBeNull();
    const loaded = buildScoreInputs(s, [], new Map([[address(1), [...fills(10), ...fills(10), { ...fills(1)[0], oid: 99, time: base + 35 * day }]]]));
    expect(loaded.inputs[0].tradeCount).toBe(10);
    expect(scoreCandidates(loaded.inputs).finalists).toEqual([address(1)]);
  });
  test("normalizes older month windows, deduplicates overlap, and excludes today's month points", () => {
    const result = buildScoreInputs(snapshot("current", 34), [snapshot("old", 2), snapshot("newer", 3)]);
    expect(result.inputs[0].history!.pnlHistory).toEqual([0, 1, 2, 3].map(i => [base + i * day, 500 + i * 10]));
    expect(result.historyAudit).toMatchObject({ inputPoints: 7, uniquePoints: 4, mismatches: [] });
    expect(scoreCandidates(result.inputs, { allowUnknown: ["minTrades"] }).candidates[0].metrics!.flags).not.toContain("history-mismatch");
  });
  test("same-time restatements use the newer observation and leave an audit trail", () => {
    const newer = snapshot("newer", 3); newer.portfolioRows[0].portfolio = payload(3, 501);
    const result = buildScoreInputs(snapshot("current", 34), [newer, snapshot("old", 2)]);
    expect(result.historyAudit.mismatches).toHaveLength(3);
    expect(result.inputs[0].history!.pnlHistory[0][1]).toBe(501);
  });
  test("future observations cannot change a historical run; duplicate run IDs are rejected", () => {
    const s = snapshot("current", 34);
    const result = buildScoreInputs(s, [snapshot("future", 35)]);
    expect(result.ignoredFutureRuns).toEqual(["future"]);
    expect(result.inputs[0].history).toBeNull();
    expect(()=>buildScoreInputs(s, [s])).toThrow("Duplicate");
  });
  test("an overlapping run cannot leak a revision acquired after this account's snapshot", () => {
    const later = snapshot("overlapping", 3);
    later.run.manifest = { runId: "overlapping", status: "complete", startedAt: stamp(34.21), finishedAt: stamp(34.27) };
    record(later).portfolio.fetchedAt = stamp(34.25);
    later.portfolioRows[0].portfolio = payload(3, 501);
    const loaded = buildScoreInputs(snapshot("current", 34), [snapshot("old", 2), later]);
    expect(loaded.ignoredFutureObservations).toEqual([{ runId: "overlapping", address: address(1) }]);
    expect(loaded.inputs[0].history!.pnlHistory[0][1]).toBe(500);
  });
  test("malformed prior history is audited while current data remains available", () => {
    const old = snapshot("old", 2);
    const raw = old.portfolioRows[0].portfolio as any;
    raw[1][1].accountValueHistory.at(-1)[1] = "999";
    const result = buildScoreInputs(snapshot("current", 34), [old]);
    expect(result.issues[0].stage).toBe("history");
    expect(result.inputs).toHaveLength(1); expect(result.inputs[0].history).toBeNull();
  });
  test("repeated timestamps from legacy DB rows stay unrankable even in preview", () => {
    const s = snapshot("current", 34); const raw = s.portfolioRows[0].portfolio as any;
    for (const key of ["accountValueHistory", "pnlHistory"]) raw[0][1][key].push([...raw[0][1][key].at(-1)]);
    const loaded = buildScoreInputs(s);
    expect(loaded.issues).toHaveLength(1);
    expect(loaded.inputs[0].links).toEqual([address(2)]);
    const result = scoreCandidates(loaded.inputs, { allowUnknown: ["minTrades"] });
    expect(result.finalists).toHaveLength(0); expect(result.candidates[0].metrics).toBeNull();
  });
  test("unknown classification is reported, never guessed from an absent contract response", () => {
    const s = snapshot("current", 34); record(s).classification = null; record(s).classificationError = "RPC failed";
    const result = buildScoreInputs(s);
    expect(result.counts.omitted).toBe(1); expect(result.issues[0].reason).toContain("Unverified classification");
  });
  test("ERC vault probes do not establish closure state", () => {
    const s = snapshot("current", 34);
    candidate(s).knownHypercoreVault = false; candidate(s).valueSource = "leaderboard-account-value";
    s.candidateRows[0].kind = "erc4626-vault";
    record(s).classification = { kind: "erc4626-vault", evidence: "erc4626-probes" };
    expect(buildScoreInputs(s).inputs[0].closed).toBeNull();
  });
  test("rejects mixed-run rows, inconsistent columns, duplicates and incomplete coverage", () => {
    for (const mutate of [
      (s: ScoreSnapshot) => { s.portfolioRows[0].run_id = "wrong"; },
      (s: ScoreSnapshot) => { s.candidateRows[0].account_value_or_tvl_usd = "1"; },
      (s: ScoreSnapshot) => { s.candidateRows[0].shortlisted = false; },
      (s: ScoreSnapshot) => { s.portfolioRows = []; },
      (s: ScoreSnapshot) => { s.candidateRows.push(s.candidateRows[0]); s.run.candidate_count = 2; },
      (s: ScoreSnapshot) => { s.candidateRows[0].kind = "trader"; },
      (s: ScoreSnapshot) => { record(s).portfolio.fetchedAt = stamp(40); },
    ]) {
      const s = snapshot("current", 34); mutate(s); expect(()=>buildScoreInputs(s)).toThrow();
    }
  });
  test("a portfolio cannot include points after its acquisition time", () => {
    const s = snapshot("current", 34); s.portfolioRows[0].portfolio = payload(35);
    const result = buildScoreInputs(s); expect(result.counts.omitted).toBe(1);
    expect(result.issues[0].reason).toContain("timestamp after fetch");
  });
});

describe("Supabase read-only adapter", () => {
  test("requires completed sync before reading portfolio tables; rejects partial collection", async () => {
    const s = snapshot("current", 34);
    const calls: Table[] = [];
    const reader = { read: async (table: Table): Promise<DbRow[]> => {
      calls.push(table); return table === "ingest_runs" ? [s.run] : table === "ingest_candidates" ? s.candidateRows : s.portfolioRows;
    } };
    s.run.sync_status = "uploading";
    await expect(readScoreSnapshot(reader, "current")).rejects.toThrow("sync_status");
    expect(calls).toEqual(["ingest_runs"]);
    s.run.sync_status = "complete"; (s.run.manifest as any).status = "partial";
    await expect(readScoreSnapshot(reader, "current")).rejects.toThrow();
  });
  test("real SDK transport only sends GET and supplies identical local/remote ScoreInput data", async () => {
    const s = snapshot("current", 34);
    const key = ["sb", "secret", "test_only_not_a_real_credential"].join("_");
    const requests: string[] = [];
    const remote = new SupabaseRemote({ url: PROJECT_URL, key }, async (input, init) => {
      expect(init?.method ?? "GET").toBe("GET");
      const url = new URL(String(input)); requests.push(url.pathname);
      expect(url.searchParams.get("run_id")).toBe("eq.current");
      return Response.json(url.pathname.endsWith("ingest_runs") ? [s.run]
        : url.pathname.endsWith("ingest_candidates") ? s.candidateRows : s.portfolioRows);
    });
    const loaded = await readScoreSnapshot(remote, "current");
    expect(buildScoreInputs(loaded)).toEqual(buildScoreInputs(s));
    expect(requests).toHaveLength(3);
  });
});

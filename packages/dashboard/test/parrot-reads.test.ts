import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { initialLiveEvents, reduceLiveEvent } from "../lib/parrot-live";
import { buildBacktest, buildRunStatus, showsCard, buildWallet, isReadTool, resolveWallet, runReadTool } from "../lib/parrot-reads";
import type { Run, Status } from "../lib/data";
import type { BacktestArtifact, FunnelArtifact } from "../../shared/dashboard";
import { walletNickname } from "../../shared/wallet-persona";

const A = `0x${"ab".repeat(20)}`;
const B = `0x${"cd".repeat(20)}`;
const run = (over: Partial<Run> = {}): Run => ({ id: "r1", runId: "mirror-1790000000", kind: "mirror", status: "executed", dryRun: true, startedAt: 1790000000000, finishedAt: 1790000005000, equityUsd: 470.5,
  plan: { orders: [{ asset: "BTC", isBuy: true, notionalUsd: 12, targetUsd: 30, currentUsd: 18 }], skipped: [] },
  evidence: { snapshotHash: "0x1234567890abcdef", configurationHash: "0xcfg", exposures: [] }, ...over });
const status = (over: Partial<Status> = {}): Status => ({ dryRun: true, account: "0xacc", controls: { paused: false }, lastRunAt: 1790000000000, ...over });

describe("get_run_status", () => {
  test("reports mode, last run, counts, equity, snapshot hash and top exposures from the data only", () => {
    const { facts, card } = buildRunStatus({ runs: [run(), run({ id: "r2", status: "failed", error: "x" })], status: status(), exposures: { runAt: 1, exposures: [{ asset: "ETH", fraction: 0.2 }, { asset: "BTC", fraction: -0.4 }, { asset: "SOL", fraction: 0.1 }] } });
    expect(facts).toContain("Dry run: no real orders are sent");
    expect(facts).toContain("1 orders");
    expect(facts).toContain("1 executed, 1 failed, 0 skipped while paused");
    expect(facts).toContain("account equity $470.50");
    expect(facts).toContain("0x12345678");
    expect(facts).toContain("BTC -40%, ETH 20%, SOL 10%"); // sorted by size, signs kept
    expect(card.kind).toBe("run");
    expect(facts.length).toBeLessThanOrEqual(1200);
  });
  test("says paused, and says nothing invented when the executor returned nothing (negative control)", () => {
    expect(buildRunStatus({ runs: [run()], status: status({ controls: { paused: true } }), exposures: null }).facts).toContain("currently paused");
    const none = buildRunStatus({ runs: null, status: null, exposures: null });
    expect(none.card.kind).toBe("unavailable");
    expect(none.facts).toContain("not available right now");
    expect(none.facts).not.toMatch(/\d/); // no number appears without data
  });
});

describe("explain_wallet", () => {
  const funnel: FunnelArtifact = { generatedAt: 1, steps: [], finalists: [{ address: A, kind: "trader", score: 1.234, picked: true, rationale: "Steady, small drawdowns." }] };
  const evidence = [{ address: A, rank: 2, maxDrawdown: 0.031, realizedVol: 0.012, tags: ["low drawdown"], sharpe: 1.8 }];
  test("resolves by list position, bird name and address prefix", () => {
    const shown = [A, B];
    expect(resolveWallet("2", shown)).toBe(B);
    expect(resolveWallet("rank 1", shown)).toBe(A);
    expect(resolveWallet(walletNickname(A), shown)).toBe(A);
    expect(resolveWallet("0xabab", shown)).toBe(A);
    expect(resolveWallet("9", shown)).toBeNull();
    expect(resolveWallet("nobody", shown)).toBeNull();
  });
  test("builds citable facts and a card from evidence, funnel and pipeline", () => {
    const pipeline = { latest: { id: 1, finalists: { finalists: [], funnel: [], overlap: { threshold: 0.5, pairs: 1, above: 0, max: 0.2, top: [], byAddress: { [A]: 0.15 } } },
      summary: [{ candidate: 1, address: A, aggressiveFit: 1, reject: 0, leverageRisk: 40, evidenceRisk: 10 }], bench: [{ address: A, fit: 1, approvedAt: 1, copyableShare: 0.72, closedPositions: 3, turnoverPerDay: 1, passesHold: true }] } } as never;
    const { facts, card } = buildWallet({ ref: "1", shown: [A, B], evidence, funnel, pipeline });
    for (const part of ["Score rank #2", "Max drawdown 3.1%", "Pipeline score 1.23", "Picked by the pipeline yes", "Leverage risk 40 of 100", "Copyable share 72%", "overlap with other picks 15%", "Steady, small drawdowns."]) expect(facts).toContain(part);
    expect(card.kind === "wallet" && card.picked).toBe(true);
    expect(facts.length).toBeLessThanOrEqual(1200);
  });
  test("an unknown reference or a wallet without any record is stated as such, never guessed", () => {
    expect(buildWallet({ ref: "zzz", shown: [A], evidence: [], funnel: null, pipeline: null }).card.kind).toBe("unavailable");
    const sample = buildWallet({ ref: "2", shown: [A, B], evidence: [], funnel, pipeline: { latest: null } as never });
    expect(sample.facts).toContain("no record of this wallet");
    expect(sample.card.kind === "wallet" && sample.card.lines.length).toBe(0);
    // A failed source is "could not read", never a claim that the wallet has no record.
    const failed = buildWallet({ ref: "2", shown: [A, B], evidence: [], funnel, pipeline: null });
    expect(failed.facts).toContain("could not be read");
    expect(failed.facts).not.toContain("no record");
    expect(failed.card.kind).toBe("unavailable");
    // A shared prefix is ambiguous: no wallet is explained.
    expect(resolveWallet("0x", [A, B])).toBeNull();
    expect(buildWallet({ ref: "0xabab", shown: [A, `0xabab${"1".repeat(36)}`], evidence: [], funnel, pipeline: null }).card.kind).toBe("unavailable");
  });
});

describe("get_backtest", () => {
  const artifact: BacktestArtifact = { generatedAt: 1790000000000, window: "1 month", series: [
    { id: "agent", label: "Agent picks", points: [[1, 1], [2, 1.12]] }, { id: "btc", label: "BTC", points: [[1, 1], [2, 1.05]] }] };
  test("states each line's return and the gap to BTC, with a history-not-promise caveat", () => {
    const { facts, card } = buildBacktest(artifact);
    expect(facts).toContain("holding BTC +5.0%");
    expect(facts).toContain("Agent picks +12.0% (+7.0 points vs BTC)");
    expect(facts).toContain("not a promise of returns");
    expect(card.kind === "backtest" && card.series.find(s => s.id === "btc")?.reference).toBe(true);
  });
  test("an unpublished backtest puts no card on screen, while other unavailable sources still do (positive control)", () => {
    expect(showsCard(buildBacktest(null).card)).toBe(false);
    expect(showsCard(buildRunStatus({ runs: null, status: null, exposures: null }).card)).toBe(true);
    expect(showsCard(buildBacktest(artifact).card)).toBe(true);
  });
  test("an unpublished backtest is unavailable", () => {
    expect(buildBacktest(null).card.kind).toBe("unavailable");
    expect(buildBacktest({ ...artifact, series: [] }).card.kind).toBe("unavailable");
  });
});

describe("the live reducer's tool allowlist", () => {
  const envelope = (nested: unknown) => ({ type: "response.event", delegation_id: "delegation_1", event: nested });
  const feed = (name: string, args = "{}") => {
    let state = reduceLiveEvent(initialLiveEvents(), JSON.stringify({ type: "session.started" }));
    state = reduceLiveEvent(state, JSON.stringify(envelope({ type: "response.created", response: { id: "response_1" } })));
    return reduceLiveEvent(state, JSON.stringify(envelope({ type: "response.output_item.done", item: { type: "function_call", call_id: "call_1", name, arguments: args } }))).calls[0];
  };
  test("accepts set_strategy and the three read-only tools", () => {
    for (const name of ["set_strategy", "get_run_status", "explain_wallet", "get_backtest"]) { const call = feed(name); expect(call.error).toBeUndefined(); expect(call.name).toBe(name); }
    expect(isReadTool("get_run_status")).toBe(true);
  });
  test("rejects any other name as an invalid call (positive control: the check fires)", () => {
    for (const name of ["pause_executor", "flatten", "trade", "web_search", "get_run_status "]) { const call = feed(name); expect(call.error).toBeDefined(); expect(call.name).toBeUndefined(); expect(call.args).toBeUndefined(); }
    expect(isReadTool("pause_executor")).toBe(false);
  });
});

describe("the read tools stay read-only", () => {
  const FORBIDDEN = /method:\s*["'](?:POST|PUT|PATCH|DELETE)["']|\/(?:pause|resume|flatten|reports|control)\b|ADMIN_TOKEN/;
  test("the scan fires on a mutation (positive control)", () => {
    expect(FORBIDDEN.test('fetch(url, { method: "POST" })')).toBe(true);
    expect(FORBIDDEN.test("`${EXECUTOR}/flatten`")).toBe(true);
    expect(FORBIDDEN.test('method: "GET"')).toBe(false);
  });
  test("parrot-reads.ts only issues GETs and names no control endpoint", () => {
    const source = readFileSync(join(import.meta.dir, "../lib/parrot-reads.ts"), "utf8");
    expect(source).toContain('method: "GET"');
    expect(FORBIDDEN.test(source)).toBe(false);
  });
});

describe("runReadTool never ends the call", () => {
  const stub = (body: unknown, ok = true) => {
    const g = globalThis as unknown as { window?: unknown; fetch: unknown };
    const saved = { window: g.window, fetch: g.fetch };
    g.window = { location: { origin: "http://demo.test" } };
    g.fetch = async () => ({ ok, json: async () => body });
    return () => { g.window = saved.window; g.fetch = saved.fetch; };
  };
  test("a malformed endpoint response becomes an unavailable card (positive control: the same stub with sane data works)", async () => {
    const restore = stub({});
    try {
      const bad = await runReadTool("get_run_status", {}, { shown: [], evidence: [] }, new AbortController().signal);
      expect(bad.card.kind).toBe("unavailable");
      expect(bad.facts).toContain("never guess");
    } finally { restore(); }
    // Positive control: the same stub shape with sane, URL-routed data goes through the builders instead of the catch.
    const g = globalThis as unknown as { fetch: unknown; window?: unknown };
    const saved = { fetch: g.fetch, window: g.window };
    g.window = { location: { origin: "http://demo.test" } };
    g.fetch = async (u: URL) => ({ ok: true, json: async () => (u.pathname.endsWith("/status") ? { dryRun: true, account: "0x", controls: { paused: false }, lastRunAt: 1 } : []) });
    try {
      const ok = await runReadTool("get_run_status", {}, { shown: [], evidence: [] }, new AbortController().signal);
      expect(ok.facts).toContain("Dry run: no real orders are sent");
      expect(ok.facts).not.toContain("never guess");
    } finally { g.fetch = saved.fetch; g.window = saved.window; }
  });
  test("an HTTP error is unavailable too, and the request is a credential-less GET", async () => {
    const g = globalThis as unknown as { fetch: unknown; window?: unknown };
    const saved = { fetch: g.fetch, window: g.window };
    let seen: RequestInit | undefined;
    g.window = { location: { origin: "http://demo.test" } };
    g.fetch = async (_u: unknown, init?: RequestInit) => { seen = init; return { ok: false, json: async () => ({}) }; };
    try {
      const out = await runReadTool("get_backtest", {}, { shown: [], evidence: [] }, new AbortController().signal);
      expect(out.card.kind).toBe("unavailable");
      expect(seen?.method).toBe("GET");
      expect(seen?.credentials).toBe("omit");
    } finally { g.fetch = saved.fetch; g.window = saved.window; }
  });
});

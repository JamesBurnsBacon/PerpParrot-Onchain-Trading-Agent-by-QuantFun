import { afterEach, expect, test } from "bun:test";
import { parsePortfolio } from "../src/score";
import { OfficialCollector } from "../src/ingest/loop/collect";
import { BudgetClient } from "../src/ingest/loop/client";
import { LoopStore, type Account } from "../src/ingest/loop/store";

const stores: LoopStore[] = [];
afterEach(() => { for (const store of stores.splice(0)) store.close(); });
const day = 86_400_000;
const address = `0x${"1".repeat(40)}` as const;
function portfolio(end: number, revision = 0) {
  const accountValueHistory = Array.from({ length: 31 }, (_, i) => [end - (30 - i) * day, String(10_000 + 100 * i + revision)]);
  const pnlHistory = accountValueHistory.map(([ts], i) => [ts, String(i * 100 + revision)]);
  return [["month", { accountValueHistory, pnlHistory }],
    ["allTime", { accountValueHistory, pnlHistory: pnlHistory.map(([ts, value]) => [ts, String(Number(value) + 500)]) }]];
}
function setup() {
  const store = new LoopStore(":memory:"); stores.push(store);
  const end = Date.now() - 10_000, raw = portfolio(end);
  const fills = Array.from({ length: 10 }, (_, oid) => ({ coin: "BTC", oid, sz: "0.1", time: end - day }));
  const account: Account = { candidate: { address, accountValueOrTvlUsd: "20000", valueSource: "leaderboard-account-value", sources: ["leaderboard"], name: null, knownHypercoreVault: false, leaderAddress: null },
    input: { address, kind: "trader", accountValue: 20000, closed: false, tradeCount: 10, ...parsePortfolio(raw), history: null, links: [] },
    fetchedAt: new Date(end).toISOString(), rawHash: store.blob(JSON.stringify(raw)), classification: { kind: "trader", evidence: "no-hyperevm-code", blockNumber: "0x1" },
    classificationAt: new Date(end).toISOString(), fillsHash: store.blob(JSON.stringify(fills)), fillsCheckedAt: new Date(end).toISOString(), basis: "verified-input" };
  return { store, account, end, raw };
}

test("official cycle refreshes portfolio, reuses durable filled-order proof and updates equity", async () => {
  const { store, account, raw } = setup(); const requests: unknown[] = [];
  const client = new BudgetClient(store, async (_url, init) => { requests.push(JSON.parse(String(init?.body))); return Response.json(raw); });
  const result = await new OfficialCollector(store, client).collect(account, new AbortController().signal);
  expect(requests).toEqual([{ type: "portfolio", user: address }]);
  expect(result.account.input.accountValue).toBe(13_000);
  expect(result.account.input.tradeCount).toBe(10);
  expect(result.account.fillsHash).toBe(account.fillsHash);
  expect(account.input.accountValue).toBe(20_000);
});

test("upstream revisions quarantine stored history, preserving the fresh response", async () => {
  const { store, account, end } = setup();
  account.input.history = { accountValueHistory: [[end - 40 * day, 8000], [end - 35 * day, 9000]], pnlHistory: [[end - 40 * day, 0], [end - 35 * day, 300]] };
  const client = new BudgetClient(store, async () => Response.json(portfolio(end, 5)));
  const result = await new OfficialCollector(store, client).collect(account, new AbortController().signal);
  expect(result.historyWarnings).toEqual(["Conflicting older history quarantined"]);
  expect(result.account.input.history).toBeNull(); expect(result.account.input.month!.pnlHistory[0][1]).toBe(5);
});

test("stale, future and negative portfolio samples fail before reuse of evidence", async () => {
  for (const offset of [-180_000, 60_000]) {
    const { store, account } = setup();
    const client = new BudgetClient(store, async () => Response.json(portfolio(Date.now() + offset)));
    await expect(new OfficialCollector(store, client).collect(account, new AbortController().signal)).rejects.toThrow("Stale/future");
  }
  const { store, account } = setup();
  const client = new BudgetClient(store, async () => Response.json(portfolio(Date.now(), -20_000)));
  await expect(new OfficialCollector(store, client).collect(account, new AbortController().signal)).rejects.toThrow("negative");
});

test("classification refresh failure is not converted to a trader", async () => {
  const { store, account, raw } = setup(); account.classificationAt = null;
  const client = new BudgetClient(store, async (_url, init) => {
    const request = JSON.parse(String(init?.body));
    return request.type === "portfolio" ? Response.json(raw) : new Response("denied", { status: 403 });
  });
  await expect(new OfficialCollector(store, client).collect(account, new AbortController().signal)).rejects.toThrow("403");
});

test("known vault uses current official TVL and closed status", async () => {
  const { store, account, raw } = setup(); account.candidate.knownHypercoreVault = true;
  const client = new BudgetClient(store, async (_url, init) => init?.body ? Response.json(raw)
    : Response.json([{ summary: { vaultAddress: address, isClosed: true, tvl: "123456", leader: address } }]));
  const result = await new OfficialCollector(store, client).collect(account, new AbortController().signal);
  expect(result.account.input.kind).toBe("hypercore-vault"); expect(result.account.input.closed).toBe(true);
  expect(result.account.input.accountValue).toBe(123456);
});

test("missing order proof is fetched and multiple fills of one order count only once", async () => {
  const { store, account, raw, end } = setup(); account.fillsHash = null;
  const fills = Array.from({ length: 15 }, () => ({ coin: "BTC", oid: 123, sz: "0.1", time: end - day }));
  const client = new BudgetClient(store, async (_url, init) => {
    const request = JSON.parse(String(init?.body));
    return Response.json(request.type === "portfolio" ? raw : fills);
  });
  const result = await new OfficialCollector(store, client).collect(account, new AbortController().signal);
  expect(result.account.input.tradeCount).toBeNull();
  expect(JSON.parse(store.raw(result.account.fillsHash!))).toHaveLength(15);
});

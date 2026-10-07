import { expect, test } from "bun:test";
import { createFinalistsSource, type FinalistsData, type TrackedAccountRow } from "../src/chat/finalists";

// Synthetic tracked accounts (fake addresses). The stored shape is Hyperliquid's `portfolio` response (decimal strings).
const DAY = 86_400_000;
const addr = (i: number) => `0x${i.toString(16).padStart(40, "0")}`;
const rows = (count: number): TrackedAccountRow[] => {
  let seed = 7;
  const random = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 2 ** 32);
  return Array.from({ length: count }, (_, i) => {
    let equity = 100_000;
    const av: [number, string][] = [], pnl: [number, string][] = [];
    for (let day = 0; day <= 90; day++) {
      const ts = Date.UTC(2026, 5, 1) + day * DAY;
      if (day) equity *= 1 + 0.002 * (1 + (i % 5)) + (random() - 0.5) * 0.02 * (1 + (i % 4));
      av.push([ts, equity.toFixed(6)]); pnl.push([ts, (equity - 100_000).toFixed(6)]);
    }
    const window = { accountValueHistory: av, pnlHistory: pnl };
    return { address: addr(i + 1), kind: "trader" as const, account_value: equity, closed: false,
      portfolio: [["month", window], ["allTime", window]], trade_count: 500, maker_share: 0.3 };
  });
};
const SAMPLE: FinalistsData = { finalists: [], dataSource: "sample" };
const sample = async () => SAMPLE;

test("scores the refreshed accounts with Score and reports them as live", async () => {
  const load = createFinalistsSource(async () => rows(60), { sample });
  const data = await load();
  expect(data.dataSource).toBe("live");
  expect(data.finalists.length).toBeGreaterThanOrEqual(5);
  expect(data.finalists.length).toBeLessThanOrEqual(25);
  for (const f of data.finalists) {
    expect(f.address).toMatch(/^0x[0-9a-f]{40}$/);
    expect(typeof f.cloneOf).toBe("boolean"); // Score decides clones; never left unknown
  }
});

test("falls back to the labelled sample: no database, too few accounts, unparsable data, or a failing query", async () => {
  const logs: string[] = [];
  const log = (m: string) => { logs.push(m); };
  expect(await createFinalistsSource(undefined, { sample })()).toBe(SAMPLE);
  expect(await createFinalistsSource(async () => rows(10), { sample, log })()).toBe(SAMPLE);
  expect(await createFinalistsSource(async () => rows(60).map(r => ({ ...r, portfolio: "not a portfolio" })), { sample, log })()).toBe(SAMPLE);
  expect(await createFinalistsSource(async () => rows(60).map(r => ({ ...r, portfolio: null })), { sample, log })()).toBe(SAMPLE);
  expect(await createFinalistsSource(async () => { throw new Error("db down"); }, { sample, log })()).toBe(SAMPLE);
  expect(logs.length).toBe(4);
});

test("one malformed stored portfolio does not take the pool down", async () => {
  const mixed = rows(60); mixed[3] = { ...mixed[3], portfolio: [["month", { accountValueHistory: [[1, "not a number"]], pnlHistory: [] }]] };
  expect((await createFinalistsSource(async () => mixed, { sample })()).dataSource).toBe("live");
});

test("caches for five minutes and shares one in-flight computation", async () => {
  let clock = 1_000, calls = 0;
  const load = createFinalistsSource(async () => { calls++; return rows(60); }, { sample, now: () => clock });
  const [a, b] = await Promise.all([load(), load()]);
  expect(a).toBe(b);
  expect(calls).toBe(1);
  clock += 299_000; await load(); expect(calls).toBe(1);
  clock += 2_000; await load(); expect(calls).toBe(2);
});

test("the live source only reads: no write verbs in the module", async () => {
  const source = await Bun.file(new URL("../src/chat/finalists.ts", import.meta.url)).text();
  for (const verb of [/\binsert\s+into\b/i, /\bupdate\s+\w+\s+set\b/i, /\bdelete\s+from\b/i]) expect(source).not.toMatch(verb);
});

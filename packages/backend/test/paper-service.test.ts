import { describe, expect, test } from "bun:test";
import configurationFixture from "../fixtures/frozen-configuration.json";
import type { FrozenConfiguration } from "../../shared/frozen";
import type { PositionsSnapshot } from "../../shared/snapshot";
import type { Market } from "../src/paper/book";
import { defaultBooks, exposuresFromSnapshot, MemoryPaperStore, PaperService } from "../src/paper/service";

const configuration = configurationFixture as FrozenConfiguration;
// Every frozen source: $1M equity, 0.5× long BTC.
const snapshot = (runAt: number): string =>
  JSON.stringify({
    snapshotId: `snap-${runAt}`,
    runAt,
    takenAt: runAt - 60,
    configuration,
    eligibleAssets: ["BTC"],
    sources: configuration.sources.map((s) => ({
      address: s.sourceAddress,
      equityE6: "1000000000000",
      positions: [{ asset: "BTC", notionalE6: "500000000000" }],
    })),
  } satisfies PositionsSnapshot);

const marketsAt = (btc: number) => async () => new Map<string, Market>([["BTC", { markPx: btc, maxLeverage: 40, feeBps: 0 }]]);
const cfg = { minOrderUsd: 10, driftFraction: 0.1, marginCap: 0.95, slippageBps: 0 };

describe("exposuresFromSnapshot", () => {
  test("matches the copy math: weights 0.75 invested × 0.5× each = 0.375 BTC", () => {
    expect(exposuresFromSnapshot(JSON.parse(snapshot(600)))).toEqual(new Map([["BTC", 0.375]]));
  });
});

describe("PaperService", () => {
  test("steps every book once per run and records equity curves", async () => {
    const store = new MemoryPaperStore();
    let price = 100_000;
    const service = new PaperService({ store, specs: defaultBooks(0.5), cfg, markets: async () => (await marketsAt(price)()) });
    await service.step(600, snapshot(600));
    price = 110_000;
    await service.step(1200, snapshot(1200));
    expect(await service.step(1200, snapshot(1200))).toEqual([]); // same run: ignored

    const view = await service.view();
    const byId = Object.fromEntries(view.books.map((b) => [b.id, b]));
    expect(view.lastRunAt).toBe(1200);
    // Aggressive held 0.375× BTC through a +10% move: +3.75%.
    expect(byId["aggressive-470"].returnPct).toBeCloseTo(3.75, 6);
    expect(byId["aggressive-10k"].returnPct).toBeCloseTo(3.75, 6);
    expect(byId["balanced-470"].returnPct).toBeCloseTo(1.875, 6);
    expect(byId["btc-hold"].returnPct).toBeCloseTo(10, 6);
    expect(byId["aggressive-470"].curve).toEqual([
      [600, 470],
      [1200, expect.closeTo(487.625, 6)],
    ]);
  });
});

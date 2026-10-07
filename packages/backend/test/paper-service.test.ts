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
    startedAt: runAt - 120,
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

describe("exposuresFromSnapshot: the mirror's checks", () => {
  test("refuses an ineligible asset", () => {
    const s = JSON.parse(snapshot(600)) as PositionsSnapshot;
    s.eligibleAssets = [];
    expect(() => exposuresFromSnapshot(s)).toThrow("ineligible asset");
  });

  test("a run where every source but one has exited follows that one at its own weight", () => {
    const s = JSON.parse(snapshot(600)) as PositionsSnapshot;
    s.sources = s.sources.map((src, i) => (i === 0 ? src : { ...src, positions: [] }));
    const full = exposuresFromSnapshot(JSON.parse(snapshot(600)) as PositionsSnapshot);
    const one = exposuresFromSnapshot(s);
    expect([...one.keys()].every((asset) => s.sources[0].positions.some((p) => p.asset === asset))).toBe(true);
    for (const [asset, fraction] of one) expect(Math.abs(fraction)).toBeLessThanOrEqual(Math.abs(full.get(asset) ?? Infinity) + 1e-9);
  });
});

describe("PaperService", () => {
  test("holds every book on a run the mirror would refuse", async () => {
    const store = new MemoryPaperStore();
    const service = new PaperService({ store, specs: defaultBooks(0.5), cfg, markets: marketsAt(100_000) });
    await service.step(600, snapshot(600));
    const bad = JSON.parse(snapshot(1200)) as PositionsSnapshot;
    bad.eligibleAssets = [];
    await expect(service.step(1200, JSON.stringify(bad))).rejects.toThrow("ineligible asset");
    expect((await service.view()).lastRunAt).toBe(600);
  });

  test("accrues funding between runs and refreshes the cached view", async () => {
    const store = new MemoryPaperStore();
    const markets = async () => new Map<string, Market>([["BTC", { markPx: 100_000, maxLeverage: 40, feeBps: 0, fundingRate: 0.0006 }]]);
    const service = new PaperService({ store, specs: defaultBooks(0.5), cfg, markets });
    await service.step(600, snapshot(600));
    expect((await service.view()).lastRunAt).toBe(600);
    await service.step(1200, snapshot(1200));
    const book = (await service.view()).books.find((b) => b.id === "aggressive-470")!;
    // $176.25 long (0.375 × 470) for 1/6 h at 0.06%/h.
    expect(book.fundingUsd).toBeCloseTo(176.25 * 0.0006 / 6, 9);
    expect(book.curve.at(-1)).toEqual([1200, expect.closeTo(470 - (176.25 * 0.0006) / 6, 9)]);
  });

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

  test("a view built while a step lands is not cached stale", async () => {
    const inner = new MemoryPaperStore();
    let slow: Promise<void> | undefined;
    const store = {
      load: async () => {
        const gate = slow; // whether this call is the slow one is decided when it starts
        const state = await inner.load();
        if (gate) await gate;
        return state;
      },
      save: inner.save.bind(inner),
      points: inner.points.bind(inner),
    };
    const service = new PaperService({ store, specs: defaultBooks(0.5), cfg, markets: marketsAt(100_000) });
    await service.step(600, snapshot(600));
    let release!: () => void;
    slow = new Promise((r) => (release = r));
    const viewing = service.view(); // reads the 600 state, then waits
    slow = undefined;
    await service.step(1200, snapshot(1200));
    release();
    expect((await viewing).lastRunAt).toBe(1200);
    expect((await service.view()).lastRunAt).toBe(1200);
  });

  test("an instance whose step finds the run already saved refreshes its view", async () => {
    const store = new MemoryPaperStore();
    const a = new PaperService({ store, specs: defaultBooks(0.5), cfg, markets: marketsAt(100_000) });
    const b = new PaperService({ store, specs: defaultBooks(0.5), cfg, markets: marketsAt(100_000) });
    await a.step(600, snapshot(600));
    expect((await b.view()).lastRunAt).toBe(600);
    await a.step(1200, snapshot(1200));
    expect(await b.step(1200, snapshot(1200))).toEqual([]);
    expect((await b.view()).lastRunAt).toBe(1200);
  });
});

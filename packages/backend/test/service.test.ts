import { describe, expect, test } from "bun:test";
import { commitment } from "../../shared/commitments";
import { checkFrozenConfiguration, type FrozenConfiguration } from "../../shared/frozen";
import type { PositionsSnapshot } from "../../shared/snapshot";
import configurationFixture from "../fixtures/frozen-configuration.json";
import { applyHysteresis, EligibilityTracker, MemoryEligibilityStore, openInterestFromMeta } from "../src/eligibility";
import type { ConfigurationSource } from "../src/configuration-source";
import { nextRunAt, SnapshotError, SnapshotService } from "../src/service";
import type { HlReader } from "../src/hyperliquid";
import { buildSnapshot, keccakUtf8, MemorySnapshotStore } from "../src/snapshot";

const configuration = configurationFixture as FrozenConfiguration;
const NOW = Date.parse("2026-10-07T12:09:10Z");

// Every source: $1M account value, 0.5× long BTC, plus a DOGE position that isn't eligible.
const hl: HlReader = {
  perp: async (_user, dex) =>
    dex === "xyz"
      ? { assetPositions: [] }
      : {
          assetPositions: [
            { position: { coin: "BTC", szi: "5", positionValue: "500000" } },
            { position: { coin: "DOGE", szi: "1", positionValue: "1" } },
          ],
        },
  portfolio: async () => [["day", { accountValueHistory: [[1, "900000"], [2, "1000000"]] }]],
};

describe("fixture configuration", () => {
  test("is a valid frozen configuration", () => {
    expect(() => checkFrozenConfiguration(keccakUtf8, configuration, configuration.configurationHash, NOW)).not.toThrow();
  });

  test("matches the hash the mirror staging config pins", () => {
    expect(configuration.configurationHash).toBe("0x088fe80aef2b0d1d58a2e483073105c141fcf4d13ef80f934dfe811c81e6e1dd");
  });
});

describe("checkFrozenConfiguration", () => {
  const check = (c: FrozenConfiguration, pinned = configuration.configurationHash, now = NOW) => () =>
    checkFrozenConfiguration(keccakUtf8, c, pinned, now);
  // Re-commit after editing so only the check under test fails.
  const edited = (patch: Partial<FrozenConfiguration>): FrozenConfiguration => {
    const { configurationHash: _, ...payload } = { ...configuration, ...patch };
    return { ...payload, configurationHash: commitment(keccakUtf8, "perpparrot:frozen:v1", payload) };
  };
  const pinnedTo = (c: FrozenConfiguration) => check(c, c.configurationHash);

  test("rejects a configuration other than the pinned one", () => {
    expect(check(configuration, `0x${"00".repeat(32)}`)).toThrow("not the pinned frozen authority");
  });

  test("rejects edits that keep the old hash", () => {
    expect(check({ ...configuration, frozenAtMs: configuration.frozenAtMs + 1 })).toThrow("frozen commitment mismatch");
  });

  test("rejects unknown fields", () => {
    expect(pinnedTo(edited({ extra: 1 } as Partial<FrozenConfiguration>))).toThrow("unknown or missing configuration fields");
  });

  test("rejects non-Aggressive or non-live policies (Aggressive is the live bucket)", () => {
    const policy = { ...configuration.policy, bucket: "BALANCED" };
    expect(pinnedTo(edited({ policy }))).toThrow("unsupported live policy");
  });

  test("rejects a policy that doesn't match its hash", () => {
    const policy = { ...configuration.policy, maxGrossLeverage: 10 };
    expect(pinnedTo(edited({ policy }))).toThrow("frozen policy mismatch");
  });

  test("rejects fewer than 5 sources", () => {
    expect(pinnedTo(edited({ sources: configuration.sources.slice(0, 4) }))).toThrow("5–25 sources");
  });

  test("rejects copying our own account", () => {
    const sources = configuration.sources.map((s, i) => (i === 0 ? { ...s, sourceAddress: configuration.account } : s));
    expect(pinnedTo(edited({ sources }))).toThrow("invalid frozen source identity/order");
  });

  test("rejects weights above their ceiling", () => {
    const sources = configuration.sources.map((s, i) => (i === 0 ? { ...s, ceilingUnits: s.weightUnits - 1 } : s));
    expect(pinnedTo(edited({ sources }))).toThrow("invalid frozen weight");
  });

  test("rejects totals that don't add up to 1", () => {
    expect(pinnedTo(edited({ cashUnits: configuration.cashUnits + 1 }))).toThrow("invalid frozen total");
  });

  test("rejects configurations frozen in the future", () => {
    expect(check(configuration, configuration.configurationHash, configuration.frozenAtMs - 1)).toThrow("future frozen configuration");
  });
});

describe("eligibility", () => {
  const meta = {
    collateralToken: 0,
    universe: [
      { name: "BTC", maxLeverage: 40 },
      { name: "OLD", maxLeverage: 10, isDelisted: true },
      { name: "xyz:HOOD", maxLeverage: 10, onlyIsolated: true, marginMode: "noCross" },
      { name: "io:ANTH", maxLeverage: 10, marginMode: "strictIsolated" },
      { name: "MID", maxLeverage: 10 },
    ],
  };
  const ctxs = [
    { openInterest: "1000", markPx: "85000" }, // $85M
    { openInterest: "1e9", markPx: "1" },
    { openInterest: "1e9", markPx: "1" },
    { openInterest: "1e9", markPx: "1" },
    { openInterest: "17000", markPx: "1000" }, // $17M
  ];

  test("keeps listed cross-margin USDC markets", () => {
    expect([...openInterestFromMeta([meta, ctxs]).keys()]).toEqual(["BTC", "MID"]);
    expect(openInterestFromMeta([{ ...meta, collateralToken: 1 }, ctxs]).size).toBe(0);
  });

  test("hysteresis: enter at $20M, stay until below $15M", () => {
    const oi = openInterestFromMeta([meta, ctxs]);
    expect(applyHysteresis(oi, new Set())).toEqual(["BTC"]);
    expect(applyHysteresis(oi, new Set(["MID"]))).toEqual(["BTC", "MID"]);
    expect(applyHysteresis(new Map([["MID", 14_999_999]]), new Set(["MID"]))).toEqual([]);
  });

  test("tracker refreshes once per UTC day and carries state across checks", async () => {
    const readings = [new Map([["MID", 25e6]]), new Map([["MID", 16e6]]), new Map([["MID", 14e6]])];
    let calls = 0;
    const tracker = new EligibilityTracker(new MemoryEligibilityStore(), async () => readings[calls++]);
    const day = 86_400_000;
    expect(await tracker.current(day + 3_600_000)).toEqual(["MID"]);
    expect(await tracker.current(day + 20 * 3_600_000)).toEqual(["MID"]); // same UTC day: cached
    expect(await tracker.current(2 * day + 60_000)).toEqual(["MID"]); // next day, $16M, already eligible
    expect(await tracker.current(3 * day + 60_000)).toEqual([]); // $14M
    expect(calls).toBe(3);
  });

  test("hysteresis survives a restart through the store", async () => {
    const store = new MemoryEligibilityStore();
    const day = 86_400_000;
    await new EligibilityTracker(store, async () => new Map([["MID", 25e6]])).current(day);
    // A new process the next day: $17M keeps MID because the store remembers it.
    expect(await new EligibilityTracker(store, async () => new Map([["MID", 17e6]])).current(2 * day)).toEqual(["MID"]);
  });

  test("refuses a check that would drop too much of the list", async () => {
    const store = new MemoryEligibilityStore();
    const day = 86_400_000;
    const all = new Map(["A", "B", "C", "D", "E", "F"].map((a) => [a, 50e6] as [string, number]));
    await new EligibilityTracker(store, async () => all).current(day);
    const refusals: string[] = [];
    const tracker = new EligibilityTracker(store, async () => new Map([["A", 50e6]]), (m) => void refusals.push(m));
    expect(await tracker.current(2 * day)).toEqual(["A", "B", "C", "D", "E", "F"]);
    expect(refusals[0]).toContain("drop 5 of 6");
    // Retried on later snapshots; once the drop has persisted for a day it's accepted.
    expect(await tracker.current(2 * day + 600_000)).toEqual(["A", "B", "C", "D", "E", "F"]);
    expect(await tracker.current(3 * day + 1)).toEqual(["A"]);
    expect((await store.load())?.refusingSince).toBeUndefined();
  });

  test("a refused drop that recovers clears the refusal", async () => {
    const store = new MemoryEligibilityStore();
    const day = 86_400_000;
    const all = new Map(["A", "B", "C", "D", "E", "F"].map((a) => [a, 50e6] as [string, number]));
    await new EligibilityTracker(store, async () => all).current(day);
    let readings = new Map([["A", 50e6]]);
    const tracker = new EligibilityTracker(store, async () => readings);
    await tracker.current(2 * day);
    readings = all;
    expect(await tracker.current(2 * day + 600_000)).toEqual(["A", "B", "C", "D", "E", "F"]);
    expect((await store.load())?.refusingSince).toBeUndefined();
  });
});

describe("buildSnapshot", () => {
  test("covers every frozen source, sorted, with eligible positions only", async () => {
    const snap = await buildSnapshot(configuration, ["BTC", "ETH"], 1_791_281_400, () => 1_791_281_350_000, hl);
    expect(snap.snapshotId).toBe("snap-1791281400");
    expect(snap.startedAt).toBe(1_791_281_350);
    expect(snap.takenAt).toBe(1_791_281_350);
    expect(snap.configuration).toBe(configuration);
    const addresses = snap.sources.map((s) => s.address);
    expect(addresses).toEqual([...addresses].sort());
    expect(addresses).toHaveLength(configuration.sources.length);
    expect(snap.sources[0]).toEqual({ address: addresses[0], equityE6: "1000000000000", positions: [{ asset: "BTC", notionalE6: "500000000000" }] });
  });
});

describe("SnapshotService", () => {
  const make = (nowMs = NOW) => {
    let builds = 0;
    const configurations: ConfigurationSource = { load: async () => configuration };
    const service = new SnapshotService({
      configurations,
      eligibility: new EligibilityTracker(new MemoryEligibilityStore(), async () => new Map([["BTC", 1e9]])),
      store: new MemorySnapshotStore(),
      nowMs: () => nowMs,
      hl: {
        perp: async (...args) => {
          builds++;
          await Bun.sleep(5);
          return hl.perp(...args);
        },
        portfolio: hl.portfolio,
      },
    });
    return { service, builds: () => builds / (2 * configuration.sources.length) };
  };
  const runAt = nextRunAt(NOW / 1000);

  test("nextRunAt is the next :x0 boundary", () => {
    expect(new Date(runAt * 1000).toISOString()).toBe("2026-10-07T12:10:00.000Z");
    expect(nextRunAt(Date.parse("2026-10-07T12:10:00Z") / 1000)).toBe(Date.parse("2026-10-07T12:20:00Z") / 1000);
  });

  test("builds once and serves identical bytes to concurrent requests", async () => {
    const { service, builds } = make();
    const [a, b, c] = await Promise.all([service.get(runAt), service.get(runAt), service.get(runAt)]);
    expect(a).toBe(b);
    expect(b).toBe(c);
    expect(await service.get(runAt)).toBe(a);
    expect(builds()).toBe(1);
    const snap = JSON.parse(a) as PositionsSnapshot;
    expect(snap.takenAt).toBe(Math.floor(NOW / 1000));
    expect(snap.startedAt).toBe(Math.floor(NOW / 1000));
  });

  test("records the completed read window instead of its start as the snapshot time", async () => {
    const times = [1_791_281_340_000, 1_791_281_380_000];
    const snap = await buildSnapshot(configuration, ["BTC"], 1_791_281_400, () => times.shift()!, hl);
    expect(snap.startedAt).toBe(1_791_281_340);
    expect(snap.takenAt).toBe(1_791_281_380);
  });

  test("refuses runs too far ahead or long past", async () => {
    const { service } = make();
    await expect(service.get(runAt + 600)).rejects.toThrow("too far ahead");
    await expect(service.get(runAt - 1200)).rejects.toThrow("has no snapshot");
  });

  test("won't pre-build a run's snapshot early, which would leave it stale", async () => {
    // The 12:10 run is 9m50s away at 12:00:10: too early to build.
    const { service } = make(Date.parse("2026-10-07T12:00:10Z"));
    await expect(service.get(runAt)).rejects.toThrow("too far ahead");
  });

  test("only builds real run times", async () => {
    const { service } = make();
    await expect(service.get(runAt + 1)).rejects.toThrow("not a mirror run time");
    await expect(service.get(runAt + 1)).rejects.toBeInstanceOf(SnapshotError);
  });

  test("tick builds only in the window before a run", async () => {
    expect(await make(Date.parse("2026-10-07T12:05:00Z")).service.tick()).toBeUndefined();
    expect(await make(Date.parse("2026-10-07T12:09:00Z")).service.tick()).toBe(runAt);
  });
});

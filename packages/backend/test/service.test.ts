import { describe, expect, test } from "bun:test";
import { checkFrozenManifest, manifestCommitment, type Manifest } from "../../shared/manifest";
import type { PositionsSnapshot } from "../../shared/snapshot";
import manifestFixture from "../fixtures/manifest.json";
import { applyHysteresis, EligibilityTracker, openInterestFromMeta } from "../src/eligibility";
import type { ManifestSource } from "../src/manifest-source";
import { nextRunAt, SnapshotError, SnapshotService } from "../src/service";
import { buildSnapshot, keccakUtf8, MemorySnapshotStore, type ReadAccount } from "../src/snapshot";

const manifest = manifestFixture as Manifest;
const NOW = Date.parse("2026-10-07T12:09:10Z");

// Every source: $1M equity on core, 0.5× long BTC, plus a DOGE position that isn't eligible.
const readAccount: ReadAccount = async (_user, dex) =>
  dex === "xyz"
    ? { marginSummary: { accountValue: "0" }, assetPositions: [] }
    : {
        marginSummary: { accountValue: "1000000" },
        assetPositions: [
          { position: { coin: "BTC", szi: "5", positionValue: "500000" } },
          { position: { coin: "DOGE", szi: "1", positionValue: "1" } },
        ],
      };

describe("fixture manifest", () => {
  test("is a valid frozen live manifest", () => {
    expect(() => checkFrozenManifest(keccakUtf8, manifest, NOW, manifest.manifestHash)).not.toThrow();
  });

  test("matches the hash the mirror config and executor pin", () => {
    expect(manifest.manifestHash).toBe("0xed75bffaf51205d926e3e71cafab945a515e8d430d2575c0ef858e9a1602e9d5");
  });
});

describe("checkFrozenManifest", () => {
  const check = (m: Manifest, now = NOW, hash = manifest.manifestHash) => () => checkFrozenManifest(keccakUtf8, m, now, hash);
  // Re-commit after editing so only the semantic check under test fails.
  const edited = (patch: Partial<Manifest>): Manifest => {
    const m = { ...manifest, ...patch };
    return { ...m, manifestHash: manifestCommitment(keccakUtf8, m) };
  };

  test("rejects a different frozen hash", () => {
    expect(check(manifest, NOW, `0x${"00".repeat(32)}`)).toThrow("not the frozen live authority");
  });

  test("rejects edits that keep the old hash", () => {
    expect(check({ ...manifest, cashWeight: 0.25 })).toThrow("manifest commitment mismatch");
  });

  test("rejects simulation and invalid manifests", () => {
    const sim = edited({ mode: "SIMULATION" });
    expect(check(sim, NOW, sim.manifestHash)).toThrow("not VALID/LIVE/OK");
  });

  test("rejects expired manifests", () => {
    expect(check(manifest, manifest.expiresAtMs)).toThrow("expired/future manifest");
  });

  test("rejects weights that don't add up with cash", () => {
    const m = edited({ cashWeight: 0.3 });
    expect(check(m, NOW, m.manifestHash)).toThrow("invalid capital total");
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

  test("tracker refreshes daily and carries state across checks", async () => {
    const readings = [new Map([["MID", 25e6]]), new Map([["MID", 16e6]]), new Map([["MID", 14e6]])];
    let calls = 0;
    const tracker = new EligibilityTracker(async () => readings[calls++]);
    expect(await tracker.current(0)).toEqual(["MID"]);
    expect(await tracker.current(3_600_000)).toEqual(["MID"]); // cached
    expect(await tracker.current(86_400_000)).toEqual(["MID"]); // $16M, already eligible
    expect(await tracker.current(2 * 86_400_000)).toEqual([]); // $14M
    expect(calls).toBe(3);
  });
});

describe("buildSnapshot", () => {
  test("covers every manifest source, sorted, with eligible positions only", async () => {
    const snap = await buildSnapshot(manifest, ["BTC", "ETH"], 1_791_281_400, 1_791_281_350, readAccount);
    expect(snap.snapshotId).toBe("snap-1791281400");
    expect(snap.manifest).toBe(manifest);
    const addresses = snap.sources.map((s) => s.address);
    expect(addresses).toEqual([...addresses].sort());
    expect(addresses).toHaveLength(manifest.sources.length);
    expect(snap.sources[0]).toEqual({ address: addresses[0], equityE6: "1000000000000", positions: [{ asset: "BTC", notionalE6: "500000000000" }] });
  });
});

describe("SnapshotService", () => {
  const make = (nowMs = NOW) => {
    let builds = 0;
    const manifests: ManifestSource = { load: async () => manifest };
    const service = new SnapshotService({
      manifests,
      eligibility: new EligibilityTracker(async () => new Map([["BTC", 1e9]])),
      store: new MemorySnapshotStore(),
      nowMs: () => nowMs,
      readAccount: async (...args) => {
        builds++;
        await Bun.sleep(5);
        return readAccount(...args);
      },
    });
    return { service, builds: () => builds / (2 * manifest.sources.length) };
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
  });

  test("refuses runs too far ahead or long past", async () => {
    const { service } = make();
    await expect(service.get(runAt + 1200)).rejects.toBeInstanceOf(SnapshotError);
    await expect(service.get(runAt - 1200)).rejects.toThrow("has no snapshot");
  });

  test("tick builds only in the window before a run", async () => {
    expect(await make(Date.parse("2026-10-07T12:05:00Z")).service.tick()).toBeUndefined();
    expect(await make(Date.parse("2026-10-07T12:09:00Z")).service.tick()).toBe(runAt);
  });
});

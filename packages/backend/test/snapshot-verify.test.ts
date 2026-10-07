import { beforeEach, describe, expect, test } from "bun:test";
import type { PerpState } from "../../shared/account";
import type { FrozenConfiguration } from "../../shared/frozen";
import configurationFixture from "../fixtures/frozen-configuration.json";
import type { ConfigurationSource } from "../src/configuration-source";
import { EligibilityTracker, MemoryEligibilityStore } from "../src/eligibility";
import type { HlReader } from "../src/hyperliquid";
import { SnapshotError, SnapshotService } from "../src/service";
import { buildSnapshot, MemorySnapshotStore } from "../src/snapshot";
import { blocks, nownodesPerp, resetVerificationStats, verificationStats, verifyMode, verifySnapshot, type PerpReader } from "../src/snapshot-verify";

const configuration = configurationFixture as FrozenConfiguration;
const NOW = Date.parse("2026-10-07T12:09:10Z");
const RUN_AT = Math.ceil(NOW / 1000 / 600) * 600;
const ASSETS = ["BTC", "ETH"];

const state = (btc: string, eth?: string): PerpState => ({
  assetPositions: [
    { position: { coin: "BTC", szi: "5", positionValue: btc } },
    ...(eth ? [{ position: { coin: "ETH", szi: "-2", positionValue: eth } }] : []),
  ],
});
// The official reader every test starts from: each source holds $500k BTC and $100k short ETH on the default dex.
const officialState = (dex: string): PerpState => (dex ? { assetPositions: [] } : state("500000", "100000"));
const hl: HlReader = {
  perp: async (_u, dex) => officialState(dex),
  portfolio: async () => [["day", { accountValueHistory: [[1, "1000000"]] }]],
};
const snapshot = () => buildSnapshot(configuration, ASSETS, RUN_AT, () => NOW, hl);

const agreeing: PerpReader = async (_u, dex) => officialState(dex);
const official: PerpReader = async (_u, dex) => officialState(dex);

beforeEach(() => resetVerificationStats());

describe("verifySnapshot", () => {
  test("two providers that agree verify", async () => {
    const out = await verifySnapshot(await snapshot(), { mode: "on", second: agreeing, official });
    expect(out.verdict).toBe("verified");
    expect(out.sources).toBe(configuration.sources.length);
    expect(out.retried).toBe(0);
    expect(blocks(out, "on")).toBe(false);
    expect(verificationStats()).toMatchObject({ checks: 1, verified: 1, mismatches: 0, unverified: 0, mode: "on" });
  });

  test("small differences are within tolerance (1% or $5)", async () => {
    const near: PerpReader = async (_u, dex) => (dex ? { assetPositions: [] } : state("504000", "100003")); // +0.8% BTC, +$3 ETH
    const out = await verifySnapshot(await snapshot(), { mode: "on", second: near, official });
    expect(out.verdict).toBe("verified");
  });

  test("a confirmed difference is a mismatch and blocks, naming the source and asset", async () => {
    const stale: PerpReader = async (_u, dex) => (dex ? { assetPositions: [] } : state("400000", "100000")); // BTC 20% off, both reads
    const out = await verifySnapshot(await snapshot(), { mode: "on", second: stale, official });
    expect(out.verdict).toBe("mismatch");
    expect(out.diffs[0]).toMatchObject({ asset: "BTC" });
    expect(out.retried).toBe(configuration.sources.length);
    expect(blocks(out, "on")).toBe(true);
    expect(verificationStats().mismatches).toBe(1);
  });

  test("a transient difference that both providers agree on a moment later is not a mismatch", async () => {
    let n = 0;
    const flaky: PerpReader = async (_u, dex) => (dex ? { assetPositions: [] } : n++ < configuration.sources.length ? state("400000", "100000") : state("500000", "100000"));
    const out = await verifySnapshot(await snapshot(), { mode: "on", second: flaky, official });
    expect(out.verdict).toBe("verified");
    expect(out.retried).toBeGreaterThan(0);
  });

  test("a stale snapshot that both providers now contradict is refused, not approved", async () => {
    // The snapshot recorded $500k BTC; on the re-read both providers agree on $100k (the first official read was stale).
    let reads = 0;
    const second: PerpReader = async (_u, dex) => (dex ? { assetPositions: [] } : state(reads++ < configuration.sources.length ? "400000" : "100000", "100000"));
    const nowOfficial: PerpReader = async (_u, dex) => (dex ? { assetPositions: [] } : state("100000", "100000"));
    const out = await verifySnapshot(await snapshot(), { mode: "on", second, official: nowOfficial });
    expect(out.verdict).toBe("mismatch");
    expect(out.diffs[0]).toMatchObject({ asset: "BTC", snapshotE6: "500000000000", secondE6: "100000000000" });
    expect(blocks(out, "on")).toBe(true);
  });

  test("the $5 floor applies to small positions; a bigger gap is still a mismatch", async () => {
    const small: HlReader = { perp: async (_u, dex) => (dex ? { assetPositions: [] } : state("100")), portfolio: hl.portfolio };
    const snap = await buildSnapshot(configuration, ASSETS, RUN_AT, () => NOW, small);
    const within: PerpReader = async (_u, dex) => (dex ? { assetPositions: [] } : state("104")); // 4% but only $4
    expect((await verifySnapshot(snap, { mode: "on", second: within, official: small.perp })).verdict).toBe("verified");
    const beyond: PerpReader = async (_u, dex) => (dex ? { assetPositions: [] } : state("110")); // $10 and 10%
    expect((await verifySnapshot(snap, { mode: "on", second: beyond, official: beyond })).verdict).toBe("mismatch");
  });

  test("an asset only one side holds counts as a difference", async () => {
    const missing: PerpReader = async (_u, dex) => (dex ? { assetPositions: [] } : state("500000")); // no ETH short
    const out = await verifySnapshot(await snapshot(), { mode: "on", second: missing, official });
    expect(out.verdict).toBe("mismatch");
    expect(out.diffs.map((d) => d.asset)).toContain("ETH");
  });

  test("an unreadable NOWNodes is unverified: stored under on, refused under strict", async () => {
    const down: PerpReader = async () => {
      throw new Error("503");
    };
    const out = await verifySnapshot(await snapshot(), { mode: "on", second: down, official });
    expect(out.verdict).toBe("unverified");
    expect(out.unverified).toHaveLength(configuration.sources.length);
    expect(blocks(out, "on")).toBe(false);
    expect(blocks(out, "strict")).toBe(true);
  });

  test("a bad tolerance setting falls back to the default instead of throwing or disabling the check", async () => {
    const stale: PerpReader = async (_u, dex) => (dex ? { assetPositions: [] } : state("100000", "100000")); // 80% off
    for (const tolerancePct of [Number.NaN, 0, -3, 1e308, 100, 51]) {
      expect((await verifySnapshot(await snapshot(), { mode: "on", second: agreeing, official, tolerancePct })).verdict).toBe("verified");
      expect((await verifySnapshot(await snapshot(), { mode: "on", second: stale, official: stale, tolerancePct })).verdict).toBe("mismatch");
    }
  });
});

describe("verifyMode", () => {
  test("needs both the flag and a key", () => {
    expect(verifyMode(undefined, "k")).toBe("off");
    expect(verifyMode("on", undefined)).toBe("off");
    expect(verifyMode("on", "k")).toBe("on");
    expect(verifyMode("strict", "k")).toBe("strict");
    expect(verifyMode("yes", "k")).toBe("off");
  });

  test("strict without a key is an error, not a silently disabled gate", () => {
    expect(() => verifyMode("strict", undefined)).toThrow("requires NOWNODES_API_KEY");
    expect(() => verifyMode("strict", "")).toThrow("requires NOWNODES_API_KEY");
  });
});

describe("nownodesPerp", () => {
  test("sends the key in a header, refuses redirects, and throws on a non-2xx", async () => {
    const seen: { url: string; key: string | null; redirect?: string; body: unknown }[] = [];
    const fake = (async (url: string, init?: RequestInit) => {
      seen.push({ url, key: new Headers(init?.headers).get("api-key"), redirect: init?.redirect, body: JSON.parse(String(init?.body)) });
      return new Response(JSON.stringify({ assetPositions: [] }), { status: seen.length === 1 ? 200 : 422 });
    }) as unknown as typeof fetch;
    const read = nownodesPerp("secret", fake);
    expect(await read("0xabc", "xyz")).toEqual({ assetPositions: [] });
    expect(seen[0]).toEqual({ url: "https://hype.nownodes.io/info", key: "secret", redirect: "error", body: { type: "clearinghouseState", user: "0xabc", dex: "xyz" } });
    await expect(read("0xabc", "")).rejects.toThrow("422");
    expect(seen[1]!.body).toEqual({ type: "clearinghouseState", user: "0xabc" });
  });
});

describe("SnapshotService with verification", () => {
  const configurations: ConfigurationSource = { load: async () => configuration } as ConfigurationSource;
  const service = (second: PerpReader, mode: "on" | "strict" = "on") => {
    const store = new MemorySnapshotStore();
    const svc = new SnapshotService({
      configurations,
      eligibility: new EligibilityTracker(new MemoryEligibilityStore(), undefined, () => {}),
      store,
      nowMs: () => NOW,
      hl,
      verify: { mode, second, official },
    });
    return { svc, store };
  };
  // The eligibility tracker needs open-interest readings; stub its current() so only verification is under test.
  const withEligibility = (s: ReturnType<typeof service>) => {
    (s.svc as unknown as { deps: { eligibility: { current: () => Promise<string[]> } } }).deps.eligibility.current = async () => ASSETS;
    return s;
  };

  test("a verified snapshot is stored and served", async () => {
    const s = withEligibility(service(agreeing));
    const json = await s.svc.get(RUN_AT);
    expect(JSON.parse(json).runAt).toBe(RUN_AT);
    expect(await s.store.get(RUN_AT)).toBe(json);
  });

  test("a mismatch stores nothing and fails the run with a 503", async () => {
    const stale: PerpReader = async (_u, dex) => (dex ? { assetPositions: [] } : state("100000", "100000"));
    const s = withEligibility(service(stale));
    const err = await s.svc.get(RUN_AT).catch((e) => e);
    expect(err).toBeInstanceOf(SnapshotError);
    expect((err as SnapshotError).status).toBe(503);
    expect((err as SnapshotError).message).toContain("cross-check (mismatch)");
    expect(await s.store.get(RUN_AT)).toBeUndefined();
  });

  test("without verify the same stale second reader changes nothing", async () => {
    const store = new MemorySnapshotStore();
    const svc = new SnapshotService({ configurations, eligibility: new EligibilityTracker(new MemoryEligibilityStore(), undefined, () => {}), store, nowMs: () => NOW, hl });
    (svc as unknown as { deps: { eligibility: { current: () => Promise<string[]> } } }).deps.eligibility.current = async () => ASSETS;
    const json = await svc.get(RUN_AT);
    expect(await store.get(RUN_AT)).toBe(json);
    expect(verificationStats().checks).toBe(0);
  });
});

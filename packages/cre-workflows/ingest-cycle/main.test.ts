import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { checkReceipt, configSchema } from "./validation";

const now = 1_791_295_800_000;
const addresses = Array.from({ length: 100 }, (_, n) => `0x${(n + 1).toString(16).padStart(40, "0")}`);
const original = { schema: "ingest-cycle-receipt.v1", runId: "ingest-1791295200", bucket: 1_791_295_200_000,
  completedAt: now - 60_000, count: 100, scoreLabel: "STRICT_REPOSITORY_SCORE", allowUnknown: [],
  artifactHash: "a".repeat(64), selected: addresses, next: addresses, oldestFetchedAt: now - 240_000 };
function fixture(overrides: Record<string, unknown> = {}) {
  const receipt = { ...original, ...overrides }, raw = JSON.stringify(receipt);
  const latest = { runId: receipt.runId, bucket: receipt.bucket, completedAt: receipt.completedAt,
    count: receipt.count, artifactHash: receipt.artifactHash, receiptHash: createHash("sha256").update(raw).digest("hex") };
  return { latest, raw };
}
describe("CRE immutable batch receipt", () => {
  test("accepts a fresh complete strict batch and returns only a small consensus observation", () => {
    const { latest, raw } = fixture();
    const observation = checkReceipt(latest, raw, now, 900);
    expect(observation.count).toBe(100);
    expect(JSON.stringify(observation).length).toBeLessThan(1024);
    expect(raw.length).toBeLessThan(25_000);
  });
  test("detects even a whitespace change in the fetched receipt", () => {
    const { latest, raw } = fixture();
    expect(() => checkReceipt(latest, raw + " ", now, 900)).toThrow("hash");
  });
  test("rejects stale, future and overlong collections", () => {
    for (const value of [{ completedAt: now + 1 }, { completedAt: now - 900_001 },
      { oldestFetchedAt: now }, { oldestFetchedAt: now - 600_001 }]) {
      const { latest, raw } = fixture(value);
      expect(() => checkReceipt(latest, raw, now, 900)).toThrow("Stale/future");
    }
  });
  test("rejects duplicate, incomplete, relaxed and mismatched batches", () => {
    for (const value of [{ selected: Array(100).fill(addresses[0]) }, { next: addresses.slice(1) },
      { count: 99 }, { allowUnknown: ["minTrades"] }, { bucket: original.bucket + 1 },
      { scoreLabel: "RESEARCH_PRIORITY" }, { runId: "ingest-1" }]) {
      const { latest, raw } = fixture(value);
      expect(() => checkReceipt(latest, raw, now, 900)).toThrow();
    }
    const { latest, raw } = fixture();
    expect(() => checkReceipt({ ...latest, artifactHash: "b".repeat(64) }, raw, now, 900)).toThrow("identity");
  });
  test("config is receiver-free and accepts only the local endpoint and ten-minute schedule", () => {
    const config = { mode: "local-simulation", schedule: "0 */10 * * * *", backendUrl: "http://127.0.0.1:8790", maxAgeSeconds: 900 };
    expect(configSchema.parse(config)).toEqual(config);
    for (const value of [{ mode: "production" }, { schedule: "*/10 * * * *" },
      { backendUrl: "https://example.com" }, { receiver: "0x1" }, { maxAgeSeconds: 901 }]) {
      expect(() => configSchema.parse({ ...config, ...value })).toThrow();
    }
  });
});

import { describe, expect, test } from "bun:test";
import { parseTargets } from "../src/targets";

const runAt = 1_791_264_000;
const body = (extra: Record<string, unknown> = {}) => ({
  runId: `mirror-${runAt}`, runAt, snapshotHash: `0x${"cd".repeat(32)}`, configurationHash: `0x${"ab".repeat(32)}`,
  account: `0x${"22".repeat(20)}`, exposures: [{ asset: "BTC", exposureE9: "3000000000" }], ...extra,
});

describe("parseTargets: pendingCloses", () => {
  test("reads the backend's pending closes; a backend without them has none", () => {
    expect(parseTargets(body({ pendingCloses: ["ETH", "xyz:CL"] }), runAt).pendingCloses).toEqual(["ETH", "xyz:CL"]);
    expect(parseTargets(body(), runAt).pendingCloses).toEqual([]);
  });

  test("rejects malformed, duplicate or targeted pending closes", () => {
    expect(() => parseTargets(body({ pendingCloses: "ETH" }), runAt)).toThrow("invalid pendingCloses");
    expect(() => parseTargets(body({ pendingCloses: ["ETH", "ETH"] }), runAt)).toThrow("invalid pendingCloses");
    expect(() => parseTargets(body({ pendingCloses: ["bad asset"] }), runAt)).toThrow("invalid pendingCloses");
    expect(() => parseTargets(body({ pendingCloses: ["BTC"] }), runAt)).toThrow("also targeted");
  });
});

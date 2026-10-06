import { describe, expect, test } from "bun:test";
import { PARROT_PRESETS } from "../../dashboard/lib/parrot-presets";
import {
  clampBanner, describeError, holdProgress, intentChips, isApiError,
  isChatResponse, isPreviewResponse, shortenAddress, typewriterFrames,
  type ChatResponse, type PreviewResponse,
} from "../../dashboard/lib/parrot";

const chat: ChatResponse = {
  ok: true, reply: "Let's keep it bounded.", clarify: null,
  intent: { riskStyle: "aggressive", maxSources: 5, diversification: "high", leverageComfort: "high",
    requestedLeverage: 100, avoidClones: true, horizon: "medium", clarify: null, reply: "Let's keep it bounded." },
  policy: { liveEligible: true, effectiveMaxSources: 5, changes: [{ field: "mode", from: "LIVE", to: "SIMULATION" }],
    clamps: [{ field: "maxGrossLeverage", requested: 100, applied: 3 }], notes: ["Bounded by code"] },
  shortlist: { addresses: ["0x123456789012345678901234567890123456abcd"], dataSource: "sample" },
  model: "test-model", latencyMs: 120,
};
const preview: PreviewResponse = {
  ok: true, requestId: "request-1", preview: { version: "1", liveEligible: false, paperOnly: true,
    weighting: "equal", policy: { bucket: "AGGRESSIVE" }, sources: [{ address: chat.shortlist.addresses[0], weightUnits: 1000, ceilingUnits: 2000 }],
    cashUnits: 9000, notes: [], previewHash: "0xabcdef" },
};

describe("parrot display helpers", () => {
  test("shortens only a complete hex address", () => {
    expect(shortenAddress(chat.shortlist.addresses[0])).toBe("0x1234...abcd");
    expect(shortenAddress("0x1234")).toBe("0x1234");
    expect(shortenAddress("not-an-address")).toBe("not-an-address");
  });
  test("friendly errors cover every code, never raw server text", () => {
    expect(describeError("disabled")).toBe("The parrot is resting: chat is switched off");
    for (const code of ["bad_request", "too_large", "model_unavailable", "invalid_model_output", "infeasible", "too_few_sources", "network"]) {
      expect(describeError(code).length).toBeGreaterThan(10);
    }
    expect(describeError("rate_limited", 12)).toContain("12 seconds");
    expect(describeError("budget", 60)).toContain("60 seconds");
    expect(describeError("budget")).not.toContain("undefined");
    expect(describeError("rate_limited")).toContain("Try again shortly");
    expect(describeError("arbitrary server message")).not.toContain("arbitrary");
  });
  test("intent chips expose all five preferences", () => {
    expect(intentChips(chat.intent)).toEqual(["Aggressive", "Up to 5 sources", "High diversification", "High leverage comfort", "Avoid clones"]);
    expect(intentChips({ ...chat.intent, avoidClones: false, diversification: "med" })).toContain("Medium diversification");
    expect(intentChips({ ...chat.intent, avoidClones: false })).toContain("Clones allowed");
  });
  test("clamp banner makes the policy boundary explicit", () => {
    expect(clampBanner([])).toBeNull();
    expect(clampBanner(chat.policy.clamps)).toBe("Capped by code: you asked 100x, the policy allows 3x");
  });
  test("typewriter schedule includes the initial and final frames, preserving emoji", () => {
    expect(typewriterFrames("A🦜", 22)).toEqual([{ atMs: 0, text: "" }, { atMs: 22, text: "A" }, { atMs: 44, text: "A🦜" }]);
    expect(typewriterFrames("", 22)).toEqual([{ atMs: 0, text: "" }]);
    expect(typewriterFrames("abc", 0)).toEqual([{ atMs: 0, text: "abc" }]);
  });
  test("hold progress is clamped and invalid clocks cannot confirm", () => {
    expect(holdProgress(100, 700, 1200)).toBe(0.5);
    expect(holdProgress(100, 0, 1200)).toBe(0);
    expect(holdProgress(100, 9999, 1200)).toBe(1);
    expect(holdProgress(0, 50, 0)).toBe(0);
    expect(holdProgress(0, NaN, 1200)).toBe(0);
  });
});

describe("untrusted API results", () => {
  test("all three cached demos match the contract and source totals", () => {
    expect(PARROT_PRESETS).toHaveLength(3);
    for (const demo of PARROT_PRESETS) {
      expect(isChatResponse(demo.chat)).toBe(true);
      expect(isPreviewResponse(demo.preview)).toBe(true);
      expect(demo.preview.preview.sources.map(s => s.address)).toEqual(demo.chat.shortlist.addresses);
      expect(demo.preview.preview.sources.reduce((total, s) => total + s.weightUnits, demo.preview.preview.cashUnits)).toBe(10000);
      expect(demo.preview.preview.sources.every(s => s.weightUnits <= s.ceilingUnits)).toBe(true);
    }
    expect(PARROT_PRESETS.some(demo => demo.chat.policy.clamps.some(c => c.requested === 100))).toBe(true);
  });
  test("accepts the complete contract", () => {
    expect(isChatResponse(chat)).toBe(true);
    expect(isPreviewResponse(preview)).toBe(true);
    expect(isApiError({ ok: false, code: "too_few_sources", reply: "ignored" })).toBe(true);
    expect(isApiError({ ok: false, code: "rate_limited", reply: "ignored", retryAfterSec: 2 })).toBe(true);
  });
  test("rejects null, arrays, strings, partial success and wrong discriminator", () => {
    for (const value of [null, [], "html", {}, { ok: true }, { ...chat, ok: false }]) expect(isChatResponse(value)).toBe(false);
    for (const value of [null, [], "html", {}, { ok: true }, { ...preview, ok: false }]) expect(isPreviewResponse(value)).toBe(false);
  });
  test("validates every nested chat structure", () => {
    for (const patch of [
      { reply: 3 }, { clarify: {} }, { model: null }, { latencyMs: NaN }, { latencyMs: -1 },
      { intent: { ...chat.intent, riskStyle: "reckless" } }, { intent: { ...chat.intent, maxSources: 4 } },
      { intent: { ...chat.intent, requestedLeverage: Infinity } }, { intent: { ...chat.intent, avoidClones: "yes" } },
      { intent: { ...chat.intent, reply: undefined } }, { intent: { ...chat.intent, horizon: "year" } },
      { policy: { ...chat.policy, changes: [{ field: "x", from: {}, to: 1 }] } },
      { policy: { ...chat.policy, clamps: [{ field: "x", requested: 100, applied: "3" }] } },
      { policy: { ...chat.policy, notes: [null] } }, { policy: { ...chat.policy, liveEligible: 1 } },
      { shortlist: { addresses: [42], dataSource: "sample" } },
      { shortlist: { addresses: ["<img src=x>"], dataSource: "live" } },
      { shortlist: { addresses: ["a".repeat(67)], dataSource: "live" } },
      { shortlist: { addresses: [""], dataSource: "live" } },
      { shortlist: { addresses: [], dataSource: "cached" } },
    ]) expect(isChatResponse({ ...chat, ...patch })).toBe(false);
  });
  test("accepts sample-fixture wallet ids as well as 0x addresses (real-backend regression)", () => {
    expect(isChatResponse({ ...chat, shortlist: { addresses: ["addr-21", "addr-04"], dataSource: "sample" } })).toBe(true);
    expect(isPreviewResponse({ ...preview, preview: { ...preview.preview, sources: [{ address: "addr-21", weightUnits: 1, ceilingUnits: 2 }] } })).toBe(true);
  });
  test("validates every nested preview structure", () => {
    expect(isPreviewResponse({ ...preview, requestId: 1 })).toBe(false);
    for (const patch of [
      { version: "2" }, { paperOnly: "yes" }, { liveEligible: null }, { policy: [] }, { weighting: null },
      { sources: [{ address: "has space", weightUnits: 1, ceilingUnits: 2 }] },
      { sources: [{ ...preview.preview.sources[0], weightUnits: NaN }] },
      { sources: [{ ...preview.preview.sources[0], ceilingUnits: -1 }] },
      { cashUnits: -1 }, { notes: [42] }, { previewHash: "" },
    ]) expect(isPreviewResponse({ ...preview, preview: { ...preview.preview, ...patch } })).toBe(false);
  });
  test("errors require known codes and valid optional retry", () => {
    for (const value of [null, {}, { ok: false, code: "unknown", reply: "x" },
      { ok: true, code: "budget", reply: "x" }, { ok: false, code: "budget" },
      { ok: false, code: "budget", reply: "x", retryAfterSec: -1 },
      { ok: false, code: "budget", reply: "x", retryAfterSec: "12" }]) expect(isApiError(value)).toBe(false);
  });
});

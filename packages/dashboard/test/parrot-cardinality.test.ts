import { expect, test } from "bun:test";
import { isChatResponse } from "../lib/parrot";
import { isLiveStrategy } from "../lib/parrot-live";
import { PARROT_PRESETS } from "../lib/parrot-presets";

const addresses = Array.from({ length: 10 }, (_, i) => `0x${i.toString(16).repeat(40)}`);
function response(count: number) {
  const chat = PARROT_PRESETS[0].chat;
  const selected = addresses.slice(0, count);
  return { ...chat, intent: { ...chat.intent, maxSources: 5 }, policy: { ...chat.policy, maxSources: 5 },
    shortlist: { ...chat.shortlist, addresses: selected }, facts: "Checked strategy.",
    evidence: selected.map(address => ({ address, rank: 1, maxDrawdown: .01, realizedVol: .01, tags: ["low vol"] })),
  };
}

test("chat caps addresses at policy.maxSources with or without evidence", () => {
  for (const count of [5, 10]) {
    const value = response(count);
    expect(isChatResponse(value)).toBe(count === 5);
    expect(isChatResponse({ ...value, evidence: undefined })).toBe(count === 5);
  }
});
test("live strategy inherits the same policy cardinality cap", () => {
  expect(isLiveStrategy(response(5))).toBe(true);
  expect(isLiveStrategy(response(10))).toBe(false);
});
test("chat and live evidence must have equal cardinality and the same ids", () => {
  const value = response(5);
  for (const evidence of [value.evidence.slice(1), [...value.evidence, value.evidence[0]],
    value.evidence.map((e, i) => i ? e : { ...e, address: addresses[9] }),
    value.evidence.map((e, i) => i ? e : value.evidence[1])]) {
    expect(isChatResponse({ ...value, evidence })).toBe(false);
    expect(isLiveStrategy({ ...value, evidence })).toBe(false);
  }
});

test("evidence optional metrics accept only finite numbers or null in chat and live", () => {
  const value = response(5);
  for (const metric of [undefined, null, 0, -.1234, 1.234, NaN, Infinity, "1", {}]) {
    const candidate = { ...value, evidence: value.evidence.map(e => ({ ...e, periodReturn: metric, sharpe: metric })) };
    const valid = metric === undefined || metric === null || (typeof metric === "number" && Number.isFinite(metric));
    expect(isChatResponse(candidate)).toBe(valid);
    expect(isLiveStrategy(candidate)).toBe(valid);
  }
});

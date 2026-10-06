import { expect, test } from "bun:test";
import * as strategy from "../src/chat/strategy";
import { strategyFacts, handleLiveStrategy, type LiveDeps } from "../src/live/handler";
import { readLiveEnv } from "../src/live/config";
import { MemoryChatLimiter } from "../src/chat/limits";
import { loadFinalists } from "../src/chat/finalists";
import { intents } from "../scripts/measure-wallet-board";
import fixture from "../fixtures/frozen-configuration.json";
import type { Policy } from "../../shared/src/contracts";
import { isLiveStrategy } from "../../dashboard/lib/parrot-live";
const base = fixture.policy as Policy;
const deps = (): LiveDeps => ({ env: readLiveEnv({ LIVE_ENABLED: "true" }), chatEnv: { ipSalt: "salt", limits: { ipHourly: 10, previewIpHourly: 100, previewGlobalDaily: 500, globalDaily: 100, dailyBudgetMicroUsd: 5000000 } }, limiter: new MemoryChatLimiter(), now: () => 2000000000000, log: () => {}, basePolicy: base, finalists: loadFinalists, fetchImpl: (() => { throw Error("No model calls"); }) as unknown as typeof fetch });
const request = (body: unknown) => new Request("http://localhost/live/strategy", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
const { reply, clarify, ...intent } = intents.balanced;
test("previous accepts known IDs and rejects unknown, oversize, duplicates and unknown keys", async () => {
  expect((await handleLiveStrategy(request({ intent, previous: ["addr-01"] }), deps())).status).toBe(200);
  for (const body of [{ intent, previous: ["unknown"] }, { intent, previous: Array.from({ length: 26 }, (_, i) => `addr-${String(i + 1).padStart(2, "0")}`) }, { intent, previous: ["addr-01", "addr-01"] }, { intent, previous: [], extra: true }, { intent, previous: null }])
    expect((await handleLiveStrategy(request(body), deps())).status).toBe(400);
});
test("selection reasons describe actual pipeline exclusions and additions", async () => {
  const data = await loadFinalists();
  const selected = strategy.selectStrategy(intents.balanced, base, data);
  const previous = data.finalists.slice(0, 25).map(f => f.address);
  const explained = strategy.explainSelection(intents.balanced, base, data, previous);
  expect(explained.evidence.map(e => e.address)).toEqual(selected.shortlist.addresses);
  expect(explained.changes!.added.map(e => e.address)).toEqual(selected.shortlist.addresses.filter(a => !previous.includes(a)));
  expect(explained.changes!.removed.map(e => e.address)).toEqual(previous.filter(a => !selected.shortlist.addresses.includes(a)));
  for (const e of explained.evidence) {
    const f = data.finalists.find(f => f.address === e.address)!;
    expect(e.maxDrawdown).toBe(Math.round(f.maxDrawdown! * 10000) / 10000);
    expect(e.tags).not.toContain("high vol"); // balanced fixture is calm
  }
  const flags = strategy.explainSelection(intents.balanced, base, data, ["addr-37", "addr-38", "addr-39", "addr-40"]);
  expect(flags.changes!.removed.map(r => r.reason)).toEqual(["flagged: overflow", "flagged: ruin", "flagged: low-coverage", "flagged: no-intervals"]);
  const clone = data.finalists.find(f => f.cloneOf)!;
  expect(strategy.explainSelection(intents.balanced, base, data, [clone.address]).changes!.removed[0].reason).toMatch(/^clone/);
  const all = strategy.explainSelection({ ...intents.balanced, riskStyle: "aggressive", maxSources: 5 }, base, data, previous);
  expect(all.changes!.removed.some(r => r.reason === "ranked below the new source limit")).toBe(true);
});
test("facts preserve policy and safety, cap each side at three and total at 1200", async () => {
  const data = await loadFinalists();
  const selection = { ...strategy.selectStrategy(intents.clamped, base, data), ...strategy.explainSelection(intents.clamped, base, data, data.finalists.slice(15, 40).map(f => f.address)) };
  const facts = strategyFacts(intents.clamped, selection);
  expect(facts).toContain("Added "); expect(facts).toContain("Removed ");
  for (const side of ["Added", "Removed"]) expect((facts.split(side)[1].split(".")[0].match(/ \(/g) ?? []).length).toBeLessThanOrEqual(3);
  expect(facts.length).toBeLessThanOrEqual(1200);
  expect(facts).toEndWith("No orders are placed; an operator must review and freeze any strategy.");
});
test("live guard rejects malformed evidence and changes", async () => {
  const valid = await (await handleLiveStrategy(request({ intent, previous: ["addr-01"] }), deps())).json() as Record<string, any>;
  expect(isLiveStrategy(valid)).toBe(true);
  for (const patch of [{ evidence: undefined }, { evidence: Array(26).fill({}) }, { evidence: [{ address: "<bad>", rank: 1, maxDrawdown: .1, annualisedVol: .2, tags: [] }] }, { evidence: valid.evidence?.map((e: object) => ({ ...e, maxDrawdown: Infinity })) }, { changes: { added: [{ address: valid.shortlist.addresses[0], reason: "model invented prose" }], removed: [] } }]) expect(isLiveStrategy({ ...valid, ...patch })).toBe(false);
});

test("facts budget includes both sides even with longest wallet IDs", async () => {
  const data = await loadFinalists();
  const selection = strategy.selectStrategy({ ...intents['safe/few'], requestedLeverage: 1000 }, base, data);
  const changes = { added: Array.from({ length: 25 }, (_, i) => ({ address: `a${i}`.padEnd(66, "a"), reason: "low drawdown" })),
    removed: Array.from({ length: 25 }, (_, i) => ({ address: `b${i}`.padEnd(66, "b"), reason: `clone of ${'c'.repeat(66)}` })) };
  const facts = strategyFacts({ ...intents['safe/few'], requestedLeverage: 1000 }, { ...selection, changes });
  expect(facts.length).toBeLessThanOrEqual(1200); expect(facts).toContain("Added "); expect(facts).toContain("Removed ");
});

test("guard fails closed for malformed shortlist before using changes", () => {
  expect(isLiveStrategy({ ok: true, intent: intents.balanced, policy: {}, shortlist: {}, facts: "Facts", changes: { added: [{ address: "addr-01", reason: "low vol" }], removed: [] }, evidence: [] })).toBe(false);
});

test("pending preview preserves the board's exact conservative membership and order", async () => {
  const { handlePreview, MemoryRequestStore } = await import("../src/chat/handler");
  const d = deps();
  const response = await handlePreview(request({ intent: intents['safe/few'] }), {
    ...d, env: { ...d.chatEnv, enabled: true, apiKey: undefined, model: "unused", priceInPerM: 0, priceOutPerM: 0 },
    callModel: async () => { throw Error("No model"); }, requests: new MemoryRequestStore(), newId: () => "pending-board",
  });
  expect(response.status).toBe(200);
  const body = await response.json() as { preview: { sources: { address: string }[] } };
  expect(body.preview.sources.map(s => s.address)).toEqual(strategy.selectStrategy(intents['safe/few'], base, await loadFinalists()).shortlist.addresses);
});

test("reason codes distinguish score-window exclusion from style priority", () => {
  const finalists = Array.from({ length: 15 }, (_, i) => ({ address: `test-${i}`, kind: "trader", score: 100 - i,
    maxDrawdown: (15 - i) / 100, annualisedVol: .2, flags: [] as string[], cloneOf: false }));
  const intent = { ...intents.balanced, maxSources: 5 };
  const result = strategy.explainSelection(intent, base, { finalists, dataSource: "sample" }, ["test-0", "test-12"]);
  expect(result.evidence.map(e => e.address)).toEqual(["test-9", "test-8", "test-7", "test-6", "test-5"]);
  expect(result.changes!.removed).toEqual([{ address: "test-0", reason: "lower priority for this style" }, { address: "test-12", reason: "outside the style score window" }]);
  expect(result.evidence.map(e => e.rank)).toEqual([10, 9, 8, 7, 6]);
  for (const row of result.changes!.added) expect(result.evidence.find(e => e.address === row.address)!.tags).toContain(row.reason);
});

test("guard bounds every evidence/change field, rejects extras, duplicates and crossed sides", async () => {
  const valid = await (await handleLiveStrategy(request({ intent, previous: ["addr-01"] }), deps())).json() as Record<string, any>;
  for (const patch of [{ rank: 0 }, { rank: NaN }, { annualisedVol: -1 }, { annualisedVol: Infinity }, { maxDrawdown: 1.1 },
    { address: "a".repeat(67) }, { tags: ["invented"] }, { tags: Array(7).fill("low vol") }, { surprise: true }]) {
    expect(isLiveStrategy({ ...valid, evidence: valid.evidence.map((e: object, i: number) => i ? e : { ...e, ...patch }) })).toBe(false);
  }
  for (const changes of [{ added: [], removed: [], extra: true }, { added: Array(26).fill({ address: "addr-01", reason: "low vol" }), removed: [] },
    { added: [{ address: "not-selected", reason: "low vol" }], removed: [] }, { added: [], removed: [{ address: valid.shortlist.addresses[0], reason: "low vol" }] }]) expect(isLiveStrategy({ ...valid, changes })).toBe(false);
});

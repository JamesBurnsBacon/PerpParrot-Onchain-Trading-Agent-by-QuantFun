import { expect, test } from "bun:test";
import { createJudgeQueue, emptyReceiptFeed } from "../lib/parrot-judge-queue";
import { buildDecisionsRequest, parseDecisionsResponse } from "../../shared/receipt";
import rawFixture from "../../backend/test/fixtures/decisions.hand-extended.json";
import { initialLiveEvents, reduceLiveEvent } from "../lib/parrot-live";
import { createSentenceSplitter } from "../lib/parrot-sentences";
const facts = "Wallet A is selected at 1.5x. No orders are placed.";
export function decision(claim: string, receipt = facts, banter = false) {
  const response = structuredClone(rawFixture); response.answers[2].probability = banter ? .1 : .99;
  return { ...parseDecisionsResponse(response), request: buildDecisionsRequest(claim, undefined, receipt), response, latencyMs: 400, costUsd: .00005 };
}
const tick = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };
function setup() {
  let now = 0, feed = emptyReceiptFeed();
  const requests: { claim: string; facts: string; signal: AbortSignal; resolve: (r: { status: number; value?: unknown }) => void }[] = [];
  const history: string[] = [];
  const queue = createJudgeQueue((claim, facts, signal) => new Promise(resolve => requests.push({ claim, facts, signal, resolve })), f => { feed = f; history.push(f.rows.map(r => `${r.claim}:${r.state}`).join("|")); }, () => now);
  return { queue, requests, history, feed: () => feed, advance: (ms: number) => { now += ms; }, finish: async (i: number, status = 200, banter = false) => {
    const r = requests[i]; r.resolve({ status, value: decision(r.claim, r.facts, banter) }); await tick();
  } };
}
test("in-flight cap stays at two during a sentence burst", async () => {
  const h = setup(); h.queue.setFacts(facts);
  for (let i = 0; i < 10; i++) h.queue.push(`Wallet sentence ${i}.`);
  await tick(); expect(h.requests).toHaveLength(2); expect(h.feed().rows.every(r => r.state === "checking")).toBe(true);
  h.advance(450); await h.finish(0); expect(h.requests).toHaveLength(3);
  expect(h.feed().rows.find(r => r.id === 1)?.roundTrip).toBe(450);
  h.queue.stop();
});
test("drop-oldest waiting at eight keeps the newest sentences", async () => {
  const h = setup(); h.queue.setFacts(facts);
  for (let i = 0; i < 11; i++) h.queue.push(`Wallet sentence ${i}.`);
  await tick(); expect(h.feed().skipped).toBe(1);
  expect(h.feed().rows.find(r => r.claim === "Wallet sentence 2.")?.state).toBe("skipped");
  await h.finish(0); expect(h.requests[2].claim).toBe("Wallet sentence 3."); h.queue.stop();
});
test("twelve starts per turn, facts pinned across turns, no-facts and consecutive dedupe", async () => {
  const h = setup(); h.queue.push("Greetings from the parrot."); expect(h.feed().skipped).toBe(1);
  h.queue.setFacts(facts);
  for (let i = 0; i < 14; i++) {
    h.queue.push(`Wallet sentence ${i}.`); h.queue.push(`Wallet sentence ${i}.`); await tick();
    if (i < 12) await h.finish(i);
  }
  expect(h.requests).toHaveLength(12); expect(h.feed().skipped).toBe(3);
  h.queue.setFacts("Wallet B replaces Wallet A. No orders are placed.");
  h.queue.push("Wallet sentence 13."); await tick(); expect(h.requests).toHaveLength(13);
  expect(h.requests[12].facts).toContain("Wallet B"); expect(h.requests[0].facts).toBe(facts);
  h.queue.stop();
});
test("old waiting sentences keep old receipt and their own twelve-call budget", async () => {
  const h = setup(); h.queue.setFacts(facts);
  for (let i = 0; i < 4; i++) h.queue.push(`Original sentence ${i}.`);
  h.queue.setFacts("A new receipt for Wallet B only."); h.queue.push("The next turn starts here.");
  await tick(); await h.finish(0); await h.finish(1); await h.finish(2);
  expect(h.requests.map(r => r.facts)).toEqual([facts, facts, facts, facts, "A new receipt for Wallet B only."]); h.queue.stop();
});
for (const status of [429, 503]) test(`pause ${status} aborts all, ignores late results and stays paused on facts update`, async () => {
  const h = setup(); h.queue.setFacts(facts); for (let i = 0; i < 5; i++) h.queue.push(`Sentence number ${i}.`);
  await tick(); await h.finish(0, status);
  expect(h.feed().paused).toBe(true); expect(h.requests.every(r => r.signal.aborted)).toBe(true);
  h.queue.setFacts(facts); h.queue.push("More words after a pause."); await h.finish(1);
  expect(h.requests).toHaveLength(2); expect(h.feed().cost).toBe(0);
});
test("abort cleanup drops waiting and ignores a noncooperative late judge", async () => {
  const h = setup(); h.queue.setFacts(facts); for (let i = 0; i < 4; i++) h.queue.push(`Sentence number ${i}.`);
  await tick(); h.queue.stop(); const count = h.history.length;
  await h.finish(0); await h.finish(1); h.queue.push("No calls after unmount.");
  expect(h.history).toHaveLength(count); expect(h.requests.every(r => r.signal.aborted)).toBe(true);
  expect(h.feed().rows.every(r => r.state === "skipped")).toBe(true);
});
test("strict guard rejects a different receipt and generic failure continues", async () => {
  const h = setup(); h.queue.setFacts(facts); h.queue.push("Wallet A is selected."); h.queue.push("Wallet B is excluded."); await tick();
  h.requests[0].resolve({ status: 200, value: decision(h.requests[0].claim, "Wrong receipt with enough characters.") }); await tick();
  await h.finish(1, 502); expect(h.feed().rows.every(r => r.state === "unavailable")).toBe(true);
  expect(h.feed().paused).toBe(false); expect(h.feed().cost).toBe(0); h.queue.stop();
});
test("feed bounded to twenty, cost counts only validated results", async () => {
  const h = setup(); h.queue.setFacts(facts); h.queue.push("Wallet A is selected."); await tick(); await h.finish(0);
  for (let i = 0; i < 40; i++) h.queue.push(`More sentences number ${i}.`);
  expect(h.feed().rows).toHaveLength(20); expect(h.feed().cost).toBe(.00005); h.queue.stop();
});
test("recorded-style reducer + splitter + queue judges while talking with receipt updates and banter", async () => {
  const h = setup(), splitter = createSentenceSplitter(); let events = initialLiveEvents();
  const emit = (delta: string, user = false) => {
    const before = events;
    events = reduceLiveEvent(events, JSON.stringify({ type: `session.${user ? "input" : "output"}_transcript.delta`, delta, start_ms: 0, end_ms: 250 }));
    if (events.transcripts !== before.transcripts && events.transcripts.at(-1)?.speaker === "parrot") splitter.push(events.transcripts.at(-1)!.delta).forEach(h.queue.push);
  };
  events = reduceLiveEvent(events, '{"type":"session.started"}');
  emit("Hello from the parrot! "); expect(h.feed().skipped).toBe(1);
  h.queue.setFacts(facts); emit("Wallet A has 1."); emit("5x leverage. The next wallet "); await tick();
  expect(h.feed().rows[0]).toMatchObject({ claim: "Wallet A has 1.5x leverage.", state: "checking" });
  expect(events.parrot).toEndWith("The next wallet "); // Later speech already started before first verdict.
  h.advance(450); await h.finish(0); expect(h.feed().rows[0].state).toBe("done");
  emit("is excluded. "); await tick();
  const nextFacts = "Wallet B is now selected. No orders are placed.";
  splitter.flush().forEach(h.queue.push); h.queue.setFacts(nextFacts);
  emit("Please bring some birdseed! "); emit("User speech must not be judged.", true); await tick();
  expect(h.requests[2].facts).toBe(nextFacts); await h.finish(2, 200, true); await h.finish(1);
  expect(h.feed().rows[0].decision?.statesAFact).toBe(.1);
  expect(h.feed().rows[1].facts).toBe(facts);
  expect(h.feed().calls).toBe(3); expect(events.closed).toBe(false);
  expect(h.history.findIndex(x => x.includes("Wallet A has 1.5x leverage.:checking"))).toBeLessThan(h.history.findIndex(x => x.includes("Wallet A has 1.5x leverage.:done")));
  h.queue.stop();
});

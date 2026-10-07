import assert from "node:assert/strict";
import { mock } from "bun:test";
import { hookHost, fakeClock, tick } from "./receipt-hook-host";
import { decision, facts } from "./receipt-data";
const host = hookHost(), clock = fakeClock();
// Any accidental real network call fails this isolated harness.
globalThis.fetch = (() => { throw new Error("network forbidden"); }) as never;
let transportStatus = 503;
mock.module("../../components/parrot/api", () => ({ backendFetch: async () => ({ status: transportStatus, ok: false }) }));
const { ParrotSfx } = await import("../../lib/parrot-sfx");
let sounds = 0;
for (const key of ["play", "kit", "unlock", "input"] as const) (ParrotSfx.prototype as any)[key] = () => { sounds++; throw new Error("receipt sound forbidden"); };
const { useSentenceReceipts } = await import("../../components/parrot/useSentenceReceipts");
let requests: { claim: string; facts: string; signal: AbortSignal; resolve: (value: any) => void; reject: (error: Error) => void }[] = [];
const judge = (claim: string, facts: string, signal: AbortSignal) => new Promise<any>((resolve, reject) => requests.push({ claim, facts, signal, resolve, reject }));
let useDefault = false;
const render = () => { const result = host.render(() => useSentenceReceipts({ judge: useDefault ? undefined : judge, now: clock.now })); host.effects(); return result; };
let receipts = render();
function begin() { receipts.begin(); receipts = render(); }
function say(claim: string) { receipts.observers.onParrotDelta!(claim); clock.advance(180); receipts = render(); }
async function finish(i: number, status = 200, fact = .99) {
  const r = requests[i]; r.resolve({ status, value: decision(r.claim, r.facts, "faithful", 1, fact) }); await tick(); receipts = render();
}
async function hidden() {
  for (const failure of [503, 404, 429, "network", "timeout", "malformed", "wrong-facts", "unknown-key"] as const) {
    begin(); receipts.observers.onStrategyFacts!(facts); say("A sentence awaiting its first result.");
    assert.equal(receipts.status, "off", "hidden when never worked: in flight");
    const i = requests.length - 1, r = requests[i];
    if (failure === "network" || failure === "timeout") r.reject(new Error(failure));
    else if (failure === "malformed") r.resolve({ status: 200, value: {} });
    else if (failure === "wrong-facts") r.resolve({ status: 200, value: decision(r.claim, "A different receipt that is not this turn.") });
    else if (failure === "unknown-key") r.resolve({ status: 200, value: { ...decision(r.claim, r.facts), surprise: true } });
    else r.resolve({ status: failure });
    await tick(); receipts = render();
    assert.equal(receipts.status, "off", `hidden when never worked: ${failure}`);
    assert.equal(receipts.latest?.decision, undefined);
  }
}
async function late() {
  begin(); receipts.observers.onStrategyFacts!(facts);
  const first = requests.length; say("The first completed sentence.");
  assert.equal(receipts.latest?.state, "checking", "sentence appears before verdict");
  say("The newest completed sentence.");
  const newest = receipts.latest!.id;
  clock.advance(420); await finish(first);
  assert.equal(receipts.status, "ready");
  assert.equal(receipts.latest?.id, newest);
  assert.equal(receipts.latest?.decision, undefined, "late result updates only its own sentence");
  assert.equal(receipts.latest?.state, "checking");
  assert.equal(receipts.rows.find(r => r.id === newest - 1)?.decision?.supported, 1);
  assert.equal(receipts.rows.find(r => r.id === newest - 1)?.roundTrip, 600);
  await finish(first + 1, 200, .1);
  assert.equal(receipts.latest?.decision?.statesAFact, .1);
}
const only = process.argv[2];
if (!only || only === "hidden") await hidden();
if (!only || only === "late") await late();
if (!only) {
  for (const status of [429, 503, 404, "timeout"] as const) {
    begin(); receipts.observers.onStrategyFacts!(facts);
    say("A successful sentence first."); await finish(requests.length - 1);
    say("A sentence after the successful one.");
    const i = requests.length - 1;
    if (status === "timeout") { requests[i].reject(new Error("timeout")); await tick(); receipts = render(); }
    else await finish(i, status);
    assert.equal(receipts.status, "paused");
    receipts.observers.onStrategyFacts!(facts); say("Speech after the pause continues.");
    assert.equal(receipts.status, "paused"); assert.equal(requests.length - 1, i);
  }
  begin(); const offset = requests.length;
  say("Greetings before any facts."); assert.equal(requests.length, offset);
  receipts.observers.onStrategyFacts!(facts);
  for (let i = 0; i < 11; i++) say(`Burst sentence number ${i}.`);
  assert.equal(requests.length - offset, 2, "two in flight");
  assert.equal(receipts.feed.skipped, 2, "greeting plus oldest waiting dropped");
  assert.equal(receipts.rows.find(r => r.claim === "Burst sentence number 2.")?.state, "skipped");
  await finish(offset); assert.equal(requests[offset + 2].claim, "Burst sentence number 3.");
  // Changing turns flushes old text against old facts, including in-flight/waiting work.
  receipts.observers.onParrotDelta!("An unfinished old turn sentence");
  const nextFacts = "Wallet B is selected instead. No orders are placed.";
  receipts.observers.onStrategyFacts!(nextFacts); receipts = render();
  assert.equal(receipts.latest?.facts, facts);
  say("A new turn sentence now."); assert.equal(receipts.latest?.facts, nextFacts);
  receipts.stop(); receipts = render();
  const saved = JSON.stringify(receipts.rows); await finish(offset + 1);
  assert.equal(JSON.stringify(receipts.rows), saved);
  assert(requests.slice(offset + 1).every(r => r.signal.aborted));
  begin(); receipts.observers.onStrategyFacts!(facts); const cap = requests.length;
  for (let i = 0; i < 15; i++) {
    say(`Sequential sentence number ${i}.`); say(`Sequential sentence number ${i}.`);
    if (i < 12) await finish(cap + i);
  }
  assert.equal(requests.length - cap, 12, "twelve per turn and dedupe");
  // Retain last ten judgments even when current feed is all skipped speech.
  for (let i = 0; i < 30; i++) say(`Overflow sentence number ${i}.`);
  assert.equal(receipts.rows.filter(r => r.decision).length, 10);
  const calls = receipts.calls, cost = receipts.cost;
  begin(); assert.equal(receipts.calls, calls); assert.equal(receipts.cost, cost); assert.equal(receipts.status, "off");
  receipts.observers.onStrategyFacts!(facts); say("A request aborted by unmount.");
  receipts.observers.onParrotDelta!("Pending sentence timer.");
  host.unmount(); assert.equal(clock.pending(), 0); assert(requests.at(-1)!.signal.aborted);
  requests.at(-1)!.resolve({ status: 200, value: decision(requests.at(-1)!.claim) }); await tick();
  // Exercise the real fetch adapter as well as the injected judge, without network.
  useDefault = true;
  for (transportStatus of [503, 404]) { receipts = render(); begin(); receipts.observers.onStrategyFacts!(facts); say("The default transport is unavailable."); await tick(); receipts = render(); assert.equal(receipts.status, "off"); host.unmount(); }
}
assert.equal(sounds, 0, "no receipt sound function is called");
host.unmount();
console.log(`sentence receipts ${only ?? "all"} GREEN`);

// Isolated, dependency-free hook runner: real hook and reducer, fake React host/WebRTC.
// No module mocks escape this subprocess. This is lifecycle coverage, not browser acceptance.
import { mock } from "bun:test";
import assert from "node:assert/strict";
let slots: any[] = [], cursor = 0, effects: (() => void)[] = [];
const same = (a: any[], b: any[]) => a && b && a.length === b.length && a.every((v, i) => v === b[i]);
mock.module("react", () => ({
  useState(initial: any) { const i = cursor++; slots[i] ??= { value: typeof initial === "function" ? initial() : initial }; return [slots[i].value, (v: any) => { slots[i].value = typeof v === "function" ? v(slots[i].value) : v; }]; },
  useRef(value: any) { const i = cursor++; return slots[i] ??= { current: value }; },
  useCallback(fn: any, deps: any[]) { const i = cursor++; if (!same(slots[i]?.deps, deps)) slots[i] = { value: fn, deps }; return slots[i].value; },
  useEffect(fn: any, deps: any[]) { const i = cursor++; if (!same(slots[i]?.deps, deps)) effects.push(() => { slots[i]?.cleanup?.(); slots[i] = { deps, cleanup: fn() }; }); },
}));
const { PARROT_PRESETS } = await import("../../lib/parrot-presets");
const strategy = { ...PARROT_PRESETS[0].chat, evidence: PARROT_PRESETS[0].chat.shortlist.addresses.map((address, i) => ({ address, rank: i + 1, maxDrawdown: .1, realizedVol: .2, tags: [] })), facts: "Wallet A is selected. No orders are placed." };
let posts: any[] = [];
mock.module("../../components/parrot/api", () => ({ post: async (path: string, body: unknown, guard: (x: unknown) => boolean) => {
  posts.push({ path, body });
  const data = path === "/live/session" ? { ok: true, session: { id: "session-1" }, transport: { sdp: "v=0\r\n" }, maxSessionSeconds: 180 } : strategy;
  assert(guard(data)); return { data };
} }));
let peer: any, stops = 0, sent: string[] = [];
const documentFake = { hidden: false, addEventListener() {}, removeEventListener() {} };
Object.defineProperty(globalThis, "document", { value: documentFake, configurable: true });
Object.defineProperty(globalThis, "navigator", { value: { mediaDevices: { getUserMedia: async () => ({ getTracks: () => [track], getAudioTracks: () => [track] }) } }, configurable: true });
const track = { enabled: true, stop() { stops++; } };
class Peer {
  iceGatheringState = "complete"; localDescription = { sdp: "v=0\r\n" }; connectionState = "connected";
  channel = { readyState: "open", onmessage: null as any, send: (v: string) => sent.push(v), close() {} };
  constructor() { peer = this; }
  createDataChannel() { return this.channel; } addTrack() {} close() {}
  async createOffer() { return { sdp: "v=0\r\n" }; } async setLocalDescription() {} async setRemoteDescription() {}
}
Object.defineProperty(globalThis, "RTCPeerConnection", { value: Peer, configurable: true });
const { useLiveTalk } = await import("../../components/parrot/useLiveTalk");
const tick = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
async function run(options: boolean, unmount = false) {
  slots = []; effects = []; stops = 0; sent = []; posts = []; track.enabled = true;
  const observations: any[] = [], strategies: any[] = []; let inputs = 0, gestures = 0;
  const render = () => { cursor = 0; const result = useLiveTalk(v => strategies.push(v), () => {}, [], { gesture: () => gestures++, input: () => inputs++ }, options ? {
    onParrotDelta: delta => observations.push(["delta", delta]), onStrategyFacts: facts => observations.push(["facts", facts]), onEnd: () => observations.push(["end"]),
  } : undefined); for (const effect of effects.splice(0)) effect(); return result; };
  let live = render(); await live.start(); live = render();
  const event = async (value: unknown) => { peer.channel.onmessage({ data: JSON.stringify(value) }); await tick(); live = render(); };
  await event({ type: "session.started" });
  await event({ type: "session.output_transcript.delta", delta: "Wallet A is selected. ", start_ms: 0, end_ms: 100 });
  await event({ type: "session.output_transcript.delta", delta: 123, start_ms: 0, end_ms: 100 }); // invalid ignored
  await event({ type: "session.input_transcript.delta", delta: "Change the flock.", start_ms: 100, end_ms: 200 });
  // Same verified protocol envelope as reducer tests.
  await event({ type: "session.delegation.created", delegation: { id: "d1", target: "responses", response_id: "r1" } });
  await event({ type: "response.event", delegation_id: "d1", event: { type: "response.output_item.done", item: { type: "function_call", name: "set_strategy", call_id: "c1", arguments: JSON.stringify(strategy.intent) } } });
  await event({ type: "response.event", delegation_id: "d1", event: { type: "response.completed", response: { id: "r1" } } });
  live.toggleMute(); live = render(); assert.equal(track.enabled, false); assert.equal(live.view.muted, true);
  live.toggleMute(); live = render(); assert.equal(track.enabled, true);
  const snapshot = { view: live.view, sent: [...sent], posts: [...posts], strategies, inputs, gestures };
  if (unmount) { for (const slot of slots) slot?.cleanup?.(); }
  else { live.end(); await event({ type: "session.closed" }); for (const slot of slots) slot?.cleanup?.(); }
  assert(stops > 0); if (options) assert(observations.some(o => o[0] === "end"));
  return { snapshot, observations };
}
const plain = await run(false), observed = await run(true);
assert.deepEqual(plain.snapshot, observed.snapshot);
assert.deepEqual(observed.observations.filter(o => o[0] === "delta"), [["delta", "Wallet A is selected. "]]);
assert.equal(observed.snapshot.inputs, 1); assert.equal(observed.snapshot.gestures, 1);
assert.deepEqual(observed.observations.filter(o => o[0] === "facts"), [["facts", strategy.facts]]);
await run(true, true);
console.log("hook regression GREEN: optional observers preserve requests, controls, view, strategy, mic teardown; End/unmount notify");

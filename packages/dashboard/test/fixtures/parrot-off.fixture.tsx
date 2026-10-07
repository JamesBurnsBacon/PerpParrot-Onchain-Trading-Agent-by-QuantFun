// Frozen single-screen redesign markup. Receipt-off cases must remain identical. No browser or network.
import { mock } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
const live = {
  active: true, remoteStream: null, audio: { current: null },
  view: { phase: "live", user: "", parrot: "A new spoken sentence.", avatar: "speaking", remaining: 120, status: "", failure: null, playbackBlocked: false, muted: false },
  start() {}, end() {}, toggleMute() {}, async resumeAudio() {},
};
mock.module("../../components/parrot/useLiveTalk", () => ({ useLiveTalk: () => live }));
let unavailable = "never";
mock.module("../../components/parrot/useSentenceReceipts", () => ({ useSentenceReceipts: () => ({
  status: "off", rows: [], latest: unavailable === "never" ? undefined : { id: 1, claim: "A new spoken sentence.", facts: "A receipt for this strategy turn.", state: "unavailable" }, calls: unavailable === "never" ? 0 : 1, cost: 0, begin() {}, observers: {},
}) }));
const { default: Page } = await import("../../app/parrot/page");
const snapshot = readFileSync(new URL("./parrot-live-before.html", import.meta.url), "utf8");
for (unavailable of ["never", "503", "404", "network", "timeout"]) {
  const stage = renderToStaticMarkup(<Page />).match(/<section class="parrot-stage[^]*?<\/section>/)![0];
  assert.equal(stage, snapshot, `live area identical: ${unavailable}`);
}
console.log("off markup GREEN");

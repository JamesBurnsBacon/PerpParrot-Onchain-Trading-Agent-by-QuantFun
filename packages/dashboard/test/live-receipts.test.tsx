import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import LiveReceiptClient, { LiveReceiptContent } from "../app/parrot/receipts/live/LiveReceiptClient";
import { ParrotEffectsProvider } from "../components/parrot/ParrotEffects";
import { buildDecisionsRequest, parseDecisionsResponse } from "../../shared/receipt";
import raw from "../../backend/test/fixtures/decisions.hand-extended.json";
import { emptyReceiptFeed, type ReceiptRow } from "../lib/parrot-judge-queue";
const facts = "Wallet A is selected. No orders are placed.";
test("live page render: controls, flock, feed, receipt, Lens badge and honesty", () => {
  const html = renderToStaticMarkup(<LiveReceiptClient />);
  for (const text of ["Talk live", "The Flock", "The Parrot&#x27;s receipts", "Receipt of this turn", "Decisions Lens", "OpenAI Decisions API", "Show the call", "Matches the receipt, not the market", "not advice", "Decisions calls this call: 0"]) expect(html).toContain(text);
  expect(html.toLowerCase()).not.toMatch(/confidence|accuracy/);
});
test("fed verdict cards show stamps, checking and dim banter without a cut", () => {
  const rows: ReceiptRow[] = ["Wallet A is selected.", "Please bring me birdseed!", "Still checking a sentence."].map((claim, i) => {
    const response = structuredClone(raw); response.answers[2].probability = i === 1 ? .1 : .99;
    return { id: i + 1, claim, facts, state: i === 2 ? "checking" : "done", ...(i === 2 ? {} : { decision: { ...parseDecisionsResponse(response), request: buildDecisionsRequest(claim, undefined, facts), response, latencyMs: 400, costUsd: .00005 } }) };
  });
  const html = renderToStaticMarkup(<ParrotEffectsProvider><LiveReceiptContent initialFacts={facts} initialFeed={{ ...emptyReceiptFeed(), rows }} /></ParrotEffectsProvider>);
  expect(html).toContain(facts); expect(html).toContain("100.0% grounding"); expect(html).toContain("MATCHES"); expect(html).toContain("checking...");
  expect(html).toMatch(/receipt-card is-banter[^]*?Please bring me birdseed![^]*?<small>banter<\/small>/);
  const banter = html.match(/<button[^>]*receipt-card is-banter[^]*?<\/button>/)![0];
  expect(banter).not.toMatch(/receipt-stamp|receipt-blade|grounding/);
  // Exact provider JSON retains its original field names; human-facing labels do not use them.
  expect(html.replace(/<pre[^]*?<\/pre>/g, "").toLowerCase()).not.toMatch(/confidence|accuracy/);
});
test("page wiring has no storage, unsafe HTML or misleading labels; links are scoped", () => {
  const source = readFileSync(new URL("../app/parrot/receipts/live/LiveReceiptClient.tsx", import.meta.url), "utf8");
  expect(source).not.toMatch(/dangerouslySetInnerHTML|localStorage|sessionStorage|confidence|accuracy/);
  for (const text of ["onEnd: stop", "mounted.current = false; stop()", "onParrotDelta", "onStrategyFacts", "now - effect.sfx.lastInput < 1200", "now - lastSound.current < 700", "effect.quiet"]) expect(source).toContain(text);
  const main = readFileSync(new URL("../app/parrot/page.tsx", import.meta.url), "utf8"); expect(main).not.toContain("/receipts");
});
test("real useLiveTalk lifecycle regression in isolated hook harness", () => {
  const result = Bun.spawnSync([process.execPath, "run", "test/fixtures/live-hook.fixture.ts"], { cwd: new URL("..", import.meta.url).pathname, stdout: "pipe", stderr: "pipe" });
  expect(result.stdout.toString() + result.stderr.toString()).toContain("hook regression GREEN");
  expect(result.exitCode).toBe(0);
});

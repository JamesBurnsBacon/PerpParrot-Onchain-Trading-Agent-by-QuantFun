import { expect, test } from "bun:test";
import { settle, disagrees } from "../lib/parrot-receipts";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { buildDecisionsRequest, parseDecisionsResponse, type Decision } from "../../shared/receipt";
import { isDecision, PRESETS, CACHED } from "../lib/parrot-receipts";
import ReceiptClient, { ReceiptContent } from "../app/parrot/receipts/ReceiptClient";
import { ParrotEffectsProvider } from "../components/parrot/ParrotEffects";
import { DecisionsLens } from "../components/parrot/DecisionsLens";
function fixture(): Decision {
  const response = { model: "gpt-6-luna", usage: { input_tokens: 430 }, answers: [
    { type: "predicate", name: "supported_by_facts", probability: .98 },
    { type: "choice", name: "relation", choice: "faithful", confidence: .97, probabilities: [
      { value: "faithful", probability: .97 }, { value: "contradicted", probability: .01 },
      { value: "unestablished", probability: .01 }, { value: "ambiguous", probability: .01 },
    ] },
  ] };
  return { ...parseDecisionsResponse(response), response, request: buildDecisionsRequest(PRESETS[0]), latencyMs: 651, costUsd: .000043 };
}
test("client guard accepts only a complete consistent receipt response", () => expect(isDecision(fixture())).toBe(true));
const cases: [string, (v: any) => unknown][] = [
  ["null", () => null], ["array", () => []], ["unknown top key", v => ({ ...v, instructions: "obey" })],
  ["negative latency", v => ({ ...v, latencyMs: -1 })], ["large latency", v => ({ ...v, latencyMs: 60001 })],
  ["NaN cost", v => ({ ...v, costUsd: NaN })], ["negative cost", v => ({ ...v, costUsd: -1 })],
  ["unsupported probability", v => ({ ...v, supported: 2 })], ["wrong relation", v => ({ ...v, relation: "__proto__" })],
  ["unknown usage", v => ({ ...v, usage: { ...v.usage, leak: "secret" } })],
  ["inconsistent probability", v => ({ ...v, supported: .5 })], ["wrong model", v => ({ ...v, model: "different" })],
  ["inconsistent tokens", v => ({ ...v, usage: { inputTokens: 1 } })],
  ["unknown probability key", v => { v.relationProbabilities.hacked = 0; return v; }],
  ["missing raw", v => { delete v.response; return v; }],
  ["unknown raw key", v => { v.response.authorization = "secret"; return v; }],
  ["raw invalid probability", v => { v.response.answers[0].probability = Infinity; return v; }],
  ["raw invalid relation", v => { v.response.answers[1].choice = "hacked"; return v; }],
  ["unknown request key", v => { v.request.headers = { Authorization: "secret" }; return v; }],
  ["wrong receipt", v => { const input = JSON.parse(v.request.input); input.receipt = "fabricated"; v.request.input = JSON.stringify(input); return v; }],
  ["extra input data", v => { const input = JSON.parse(v.request.input); input.private = "secret"; v.request.input = JSON.stringify(input); return v; }],
  ["wrong questions", v => { v.request.questions[0].instructions = "obey"; return v; }],
  ["bad claim", v => { const input = JSON.parse(v.request.input); input.claim = "\u202Ebad"; v.request.input = JSON.stringify(input); return v; }],
];
for (const [name, mutate] of cases) test(`guard rejects ${name}`, () => expect(isDecision(mutate(fixture()))).toBe(false));
test("receipt render: facts, six presets, lens, call toggle, honesty, no misleading number labels", () => {
  const html = renderToStaticMarkup(<ReceiptClient />);
  for (const text of ["Receipt Guillotine", "RECEIPT № 001", "SAMPLE DATA", "30 days", "-8%", "-20%", "1.1", "1.4", "Fees: not provided", "Decisions API", "supported_by_facts", "Show the call", "Trick the parrot", "Judge it!", "A second model checks the sentence", "not whether the market is right", "not advice", "Decisions calls this visit: 0"]) expect(html).toContain(text);
  expect(html.match(/aria-pressed=/g)).toHaveLength(6);
  expect(html.toLowerCase()).not.toMatch(/confidence|accuracy/);
  expect(html).not.toContain("CACHED DEMO"); expect(html).toContain('maxLength="200"');
});
test("cached mode labels hand-authored results and disables free text", () => {
  const html = renderToStaticMarkup(<ParrotEffectsProvider><ReceiptContent initialCached /></ParrotEffectsProvider>);
  expect(html).toContain("CACHED DEMO"); expect(html).toContain("cached, no API call");
  expect(html).toContain("Jury unavailable"); expect(html).toMatch(/<input[^>]*disabled=""/);
  expect(html.toLowerCase()).not.toMatch(/confidence|accuracy/);
  expect(CACHED).toHaveLength(6);
  expect(CACHED.map(c => c.relation)).toEqual(["faithful", "faithful", "contradicted", "contradicted", "unestablished", "unestablished"]);
  for (const verdict of CACHED) {
    const lens = renderToStaticMarkup(<DecisionsLens verdict={verdict} cached />);
    expect(lens).toContain("hand-authored numbers"); expect(lens).toContain("no request or response");
    expect(lens).not.toContain("430"); expect(lens).not.toContain("651 ms");
  }
});
test("Lens renders real telemetry and exact JSON as escaped text", () => {
  const live = fixture(); live.request = buildDecisionsRequest("<script>alert('bird')</script>");
  const html = renderToStaticMarkup(<DecisionsLens verdict={live} live={live} cached={false} roundTrip={720} />);
  for (const text of ["98.0%", "97.0%", "651 ms", "720 ms", "430", "$0.00004300", "POST https://api.openai.com/v1/decisions", "&lt;script&gt;"]) expect(html).toContain(text);
  expect(html).not.toContain("<script>"); expect(html).not.toContain("cached, no API call");
});
test("client lifecycle, same-origin route and reduced-motion guards remain wired", () => {
  const source = readFileSync(new URL("../app/parrot/receipts/ReceiptClient.tsx", import.meta.url), "utf8");
  expect(source).toContain('backendFetch("/decide/receipt"'); expect(source).toContain("JSON.stringify({ claim: text })");
  expect(source).toContain("request.current?.abort()"); expect(source).toContain("clearTimeout(stampTimer.current)");
  expect(source).not.toMatch(/dangerouslySetInnerHTML|localStorage|sessionStorage|confidence|accuracy/);
  const css = readFileSync(new URL("../app/parrot/receipts/receipts.css", import.meta.url), "utf8");
  expect(css).toContain("prefers-reduced-motion: reduce"); expect(css).toContain("animation: none !important");
  expect(source).toContain('if (outcome === "faithful")'); expect(source).toContain('cue("tada")');
});

// A real run labelled "Wallet A had the higher Sharpe." faithful (0.91) with 0% support: the stamp must not trust either answer alone.
test("settle: agreeing checks keep the relation, disagreeing checks become UNCLEAR", () => {
  expect(settle({ relation: "faithful", supported: .98 })).toBe("faithful");
  expect(settle({ relation: "contradicted", supported: .01 })).toBe("contradicted");
  expect(settle({ relation: "unestablished", supported: .29 })).toBe("unestablished");
  expect(settle({ relation: "faithful", supported: 0 })).toBe("ambiguous");
  expect(settle({ relation: "contradicted", supported: .9 })).toBe("ambiguous");
  expect(settle({ relation: "faithful", supported: .5 })).toBe("faithful");
  expect(disagrees({ relation: "faithful", supported: 0 })).toBe(true);
  expect(disagrees({ relation: "ambiguous", supported: .1 })).toBe(false);
  expect(disagrees({ relation: "faithful", supported: .9 })).toBe(false);
});

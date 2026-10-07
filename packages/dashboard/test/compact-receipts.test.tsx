import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { CompactReceipt } from "../components/parrot/CompactReceipt";
import { DecisionsDrawer } from "../components/parrot/DecisionsDrawer";
import type { ReceiptRow } from "../lib/parrot-judge-queue";
import { row } from "./fixtures/receipt-data";
const render = (latest: ReceiptRow, status: "ready" | "paused" | "off" = "ready", active = true) => renderToStaticMarkup(
  <CompactReceipt active={active} status={status} latest={latest} rows={[latest]} calls={17} cost={.00085} />);
for (const [relation, support, label] of [
  ["faithful", .98, "MATCHES"], ["contradicted", .03, "CONTRADICTED"], ["unestablished", .02, "NOT ON THE RECEIPT"],
  ["faithful", .24, "UNCLEAR"], ["contradicted", .81, "UNCLEAR"], ["ambiguous", .4, "UNCLEAR"],
] as const) test(`one row: ${relation} / ${support} settles to ${label}`, () => {
  const html = render(row(1, relation, support));
  expect(html).toContain(label); expect(html).toContain(`${Math.round(support * 100)}%`);
  expect(html).toContain("compact-receipt-meter");
  expect(html.match(/class="compact-receipt-row"/g)).toHaveLength(1);
  const header = html.match(/class="compact-receipt-header"[^]*?<\/button>/)![0];
  expect(header).toContain('aria-label="Audited by OpenAI Decisions"');
  expect(header).toContain('role="img" aria-label="OpenAI"');
  expect(header).not.toContain(">Audited by OpenAI Decisions</button>");
  expect(html).not.toMatch(/\bms\b|17 calls|0\.00085|<dialog|Show the call/);
});
test("checking replaces the prior sentence's verdict", () => {
  const checking = { ...row(2), state: "checking", decision: undefined } as ReceiptRow;
  const html = renderToStaticMarkup(<CompactReceipt active status="ready" rows={[checking, row(1)]} latest={checking} calls={2} cost={.00005} />);
  expect(html).toContain("Checking…"); expect(html).toContain(checking.claim);
  expect(html).not.toContain(row(1).claim); expect(html).not.toMatch(/MATCHES|compact-receipt-stamp|%/);
});
test("banter has no stamp or grounding percentage", () => {
  const html = render(row(1, "faithful", .98, .1));
  expect(html).toContain("banter"); expect(html).not.toMatch(/compact-receipt-stamp|compact-receipt-meter|%/);
});
test("paused after working suppresses even an existing successful stamp", () => {
  const html = render(row(), "paused");
  expect(html).toContain("Receipts paused"); expect(html).not.toMatch(/MATCHES|compact-receipt-stamp|%/);
});
test("hidden when never worked and outside an active call", () => {
  expect(render(row(), "off")).toBe("");
  expect(render(row(), "ready", false)).toBe("");
  expect(render(row(), "paused", false)).toBe("");
});
test("drawer retains sentences, turn facts, disagreement and ten judged choices without JSON viewers", () => {
  const rows = [row(14, "faithful", .24), row(13, "contradicted", .81), row(12, "faithful", .98, .1), ...Array.from({ length: 11 }, (_, i) => row(11 - i))];
  const html = renderToStaticMarkup(<DecisionsDrawer rows={rows} initial={rows[0]} calls={14} cost={.0007} opener={{} as never} onClose={() => {}} />);
  for (const text of ["Decisions", "Grounding", "24%", "UNCLEAR", "450 ms", "Calls", "Turn facts", rows[0].facts.slice(0, 180), rows[0].claim]) expect(html).toContain(text);
  expect(html.match(/<option /g)).toHaveLength(10);
  expect(html).toContain(rows[1].claim); expect(html).toContain(rows[2].claim);
  expect(html).toContain('aria-modal="true"'); expect(html).toContain('aria-labelledby="parrot-decisions-title"');
  expect(html).not.toContain("<dialog open");
  expect(html).not.toContain("<pre>");
  expect(html).not.toContain("Show the call");
});
for (const [fixture, marker] of [["sentence-receipts.fixture.ts", "sentence receipts all GREEN"], ["receipt-interactions.fixture.tsx", "receipt interactions GREEN"], ["parrot-off.fixture.tsx", "off markup GREEN"]]) test(`isolated real-component/hook regression: ${fixture}`, () => {
  const result = Bun.spawnSync([process.execPath, "run", `test/fixtures/${fixture}`], { cwd: new URL("..", import.meta.url).pathname, stdout: "pipe", stderr: "pipe" });
  expect(result.stdout.toString() + result.stderr.toString()).toContain(marker); expect(result.exitCode).toBe(0);
});
test("production uses the shared observer silently; scoped CSS keeps 44px/12px and reduced motion", () => {
  const source = (file: string) => readFileSync(new URL(`../${file}`, import.meta.url), "utf8");
  for (const path of ["components/parrot/useSentenceReceipts.ts", "components/parrot/CompactReceipt.tsx", "components/parrot/DecisionsDrawer.tsx"]) {
    expect(source(path)).not.toMatch(/\.sfx|\.cue\(|\.play\(|AudioContext|localStorage|sessionStorage|dangerouslySetInnerHTML/);
  }
  const page = source("app/parrot/page.tsx");
  expect(page).toContain("receipts.begin()"); expect(page).toContain("receipts.observers");
  expect(page.indexOf("<CompactReceipt")).toBeGreaterThan(page.indexOf("<LiveTalk"));
  expect(page.indexOf("<CompactReceipt")).toBeLessThan(page.indexOf("<StageFlock"));
  expect(page).toContain("not advice · the parrot cannot trade");
  const css = source("app/parrot/parrot-show.css").split("/* A2:")[1];
  for (const text of ["max-width: 320px", "min-height: 44px", "font-size: 12px", "text-overflow: ellipsis", "prefers-reduced-motion", "animation: none"]) expect(css).toContain(text);
  expect(css).not.toMatch(/@keyframes|animation:(?! none)/);
});

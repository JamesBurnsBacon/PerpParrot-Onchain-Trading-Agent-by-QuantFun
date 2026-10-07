import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { LiveCards } from "../components/parrot/LiveCards";
import { buildBacktest, buildRunStatus, buildWallet } from "../lib/parrot-reads";

const A = `0x${"ab".repeat(20)}`;
const html = (card: Parameters<typeof LiveCards>[0]["card"]) => renderToStaticMarkup(<LiveCards card={card} onClose={() => {}} />);

test("no card renders nothing", () => expect(html(null)).toBe(""));

test("a run card shows the Run log, dry-run mode and no control that acts on the account", () => {
  const { card } = buildRunStatus({ status: { dryRun: true, account: "0x", controls: { paused: false }, lastRunAt: 1 }, exposures: { runAt: 1, exposures: [{ asset: "BTC", fraction: 0.3 }] },
    runs: [{ id: "r", runId: "mirror-1790000000", kind: "mirror", status: "executed", dryRun: true, startedAt: 1790000000000, finishedAt: 1790000001000, evidence: { snapshotHash: "0x1234567890abcdef", configurationHash: "0xc", exposures: [] } }] });
  const out = html(card);
  expect(out).toContain("Run log");
  expect(out).toContain("dry run");
  expect(out).toContain("Latest target exposures");
  expect(out).not.toMatch(/Pause|Resume|Flatten/i);
});

test("a wallet card shows measurements, the review note and the not-a-promise line", () => {
  const { card } = buildWallet({ ref: "1", shown: [A], evidence: [{ address: A, rank: 3, maxDrawdown: 0.05, realizedVol: 0.01, tags: [] }],
    funnel: { generatedAt: 1, steps: [], finalists: [{ address: A, kind: "trader", score: 2, picked: true, rationale: "Calm and copyable." }] }, pipeline: null });
  const out = html(card);
  for (const part of ["Max drawdown", "5%", "Calm and copyable.", "Past measurements, not a promise of returns.", " · picked"]) expect(out).toContain(part);
});

test("a backtest card draws the chart with the BTC reference and the caveat; unavailable cards say so", () => {
  const out = html(buildBacktest({ generatedAt: 1790000000000, window: "1 month", series: [{ id: "agent", label: "Agent picks", points: [[1790000000000, 1], [1790086400000, 1.1]] }, { id: "btc", label: "BTC", points: [[1790000000000, 1], [1790086400000, 1.02]] }] }).card);
  expect(out).toContain("Backtest vs BTC");
  expect(out).toContain("1 month");
  expect(out).toContain("<svg");
  expect(out).toContain("History, not a promise of returns.");
  const none = html(buildBacktest(null).card);
  expect(none).toContain("Backtest not available");
  expect(none).not.toContain("<svg");
});

const PLAN = { asOfMs: 1790000000000, equityUsd: 470, marginScale: 0.8, grossUsd: 150, skipped: [{ asset: "DOGE", reason: "NOT_TRADABLE" as const, targetUsd: 20 }],
  orders: [{ asset: "BTC", isBuy: true, size: "0.00100", notionalUsd: 100, markPx: 100000 }, { asset: "ETH", isBuy: false, size: "0.0125", notionalUsd: -50, markPx: 4000 }] };

test("an awaiting request card shows the dry-run sketch, says nothing is sent, and offers the Confirm button only then", () => {
  const out = renderToStaticMarkup(<LiveCards card={{ kind: "request", stage: "awaiting", plan: PLAN, previewHash: `0x${"ab".repeat(32)}`, requestId: null, sources: 5 }} onClose={() => {}} onConfirm={() => {}} />);
  for (const part of ["Order preview", "Hypothetical", "Nothing is sent", "Buy BTC", "Sell ETH", "2 orders", "margin rule scaled to 80%", "1 legs skipped", "Confirm (save pending request)", "Say “yes”"]) expect(out).toContain(part);
  expect(out).not.toContain("PENDING ·");
});

test("a saved request card shows PENDING with the request id, no order wording and no Confirm button", () => {
  const out = renderToStaticMarkup(<LiveCards card={{ kind: "request", stage: "saved", plan: PLAN, previewHash: `0x${"ab".repeat(32)}`, requestId: "req-9", sources: 5 }} onClose={() => {}} onConfirm={() => {}} />);
  expect(out).toContain("PENDING");
  expect(out).toContain("req-9");
  expect(out).toContain("No orders were placed");
  expect(out).not.toContain("Confirm (save pending request)");
  expect(out).not.toMatch(/<button[^>]*>[^<]*(place|submit|execute) order/i); // no control that acts on an account
});

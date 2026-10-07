import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { PaperTable } from "../components/Charts";
import { liveBookRow, type Run, type Series } from "../lib/data";

const book = (id: string, equityUsd: number, returnPct: number, openPositions: number) =>
  ({ id, kind: "copy", equityUsd, returnPct, openPositions, startingEquityUsd: 470, feesUsd: 1, fundingUsd: 0, trades: 3 }) as never;
const books = [book("balanced-470", 470, 0, 3), book("conservative-470", 470.02, 0.01, 2)];
const line = (id: string, label: string, bookId: string | undefined, last: number): Series =>
  ({ id, label, short: label, bookId, color: "#3f9a3a", points: [[1, 0], [2, last]] }) as Series;
// The live account is the Aggressive curve with no paper book: that is the case where its row used to disappear.
const series = [line("aggressive", "Aggressive", undefined, 0.09), line("balanced", "Balanced ×0.5", "balanced-470", 0), line("conservative", "Conservative ×0.25", "conservative-470", 0.01)];

const run = (over: Partial<Run>): Run => ({ id: "r", runId: "mirror-1", kind: "mirror", status: "executed", dryRun: false, startedAt: 1, finishedAt: 2, ...over });

test("the live Aggressive account gets its own row, first, with equity, return and positions", () => {
  const html = renderToStaticMarkup(<PaperTable books={books} series={series} live={{ equityUsd: 470.41, positions: 5 }} />);
  const body = html.slice(html.indexOf("<tbody>"));
  expect(body.indexOf("Aggressive")).toBeGreaterThan(-1);
  expect(body.indexOf("Aggressive")).toBeLessThan(body.indexOf("Balanced"));
  expect(html).toContain("$470.41");
  expect(html).toContain("+0.09%");
  expect(html).toContain(">5<");
});

test("without a live row the Aggressive line stays out of the table (the old behaviour for paper-only data)", () => {
  const html = renderToStaticMarkup(<PaperTable books={books} series={series} />);
  expect(html.slice(html.indexOf("<tbody>"))).not.toContain("Aggressive");
});

test("an unknown position count reads as a dash, and the costs table stays paper-only", () => {
  const html = renderToStaticMarkup(<PaperTable books={books} series={series} live={{ equityUsd: 470.41, positions: null }} />);
  expect(html).toContain("—");
  const costs = html.slice(html.indexOf("<summary>Costs</summary>"));
  expect(costs).not.toContain("Aggressive");
});

test("liveBookRow: latest equity, and the nonzero targets of the last executed live run", () => {
  const equity = { runs: 2, points: [[1, 470], [2, 470.41]] as [number, number][] };
  const targets = [{ asset: "BTC", exposureE9: "-1000" }, { asset: "ETH", exposureE9: "0" }, { asset: "SOL", exposureE9: "-0" }, { asset: "HYPE", exposureE9: "250000000" }];
  expect(liveBookRow(equity, [run({ evidence: { snapshotHash: "h", configurationHash: "c", exposures: targets } })])).toEqual({ equityUsd: 470.41, positions: 2 });
  // a dry run, a skipped run or a missing record gives no count, never a wrong one
  expect(liveBookRow(equity, [run({ dryRun: true, evidence: { snapshotHash: "h", configurationHash: "c", exposures: targets } })])?.positions).toBeNull();
  expect(liveBookRow(equity, [run({ status: "skipped_paused" })])?.positions).toBeNull();
  expect(liveBookRow(equity, [run({})])?.positions).toBeNull();
  expect(liveBookRow(equity, null)?.positions).toBeNull();
  expect(liveBookRow({ runs: 0, points: [] }, null)).toBeNull();
  expect(liveBookRow(null, null)).toBeNull();
});

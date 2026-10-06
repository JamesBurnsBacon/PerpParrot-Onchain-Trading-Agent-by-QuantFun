import assert from "node:assert/strict";
import test from "node:test";
import { runPointInTimeBacktest, type BacktestSource } from "../../src/backtest/point-in-time";

const DAY = 86_400_000;
const start = 1_800_000_000_000;
const makeSource = (n: number, daily: number): BacktestSource => {
  const accountValueHistory: [number, number][] = [];
  const pnlHistory: [number, number][] = [];
  let equity = 20_000;
  let pnl = 0;
  for (let i = 0; i < 31; i++) {
    const ts = start + i * DAY;
    accountValueHistory.push([ts, equity]);
    pnlHistory.push([ts, pnl]);
    const delta = equity * daily;
    equity += delta;
    pnl += delta;
  }
  return { address: `0x${n.toString(16).padStart(40, "0")}`, month: { accountValueHistory, pnlHistory } };
};

test("uses a shared cutoff and reports held-out source outcomes", () => {
  const sources = Array.from({ length: 8 }, (_, i) => makeSource(i + 1, i < 4 ? 0.01 : -0.001));
  const result = runPointInTimeBacktest(sources, { cutoffMs: start + 16 * DAY + DAY / 2, asOfMs: start + 30 * DAY, finalists: 4 });
  assert.equal(result.sourceCount, 8);
  // The production scorer deduplicates highly correlated leaders before filling slots.
  assert.ok(result.selectedCount > 0 && result.selectedCount <= 4);
  assert.ok(result.selectedMedianReturn > result.cohortMedianReturn);
  assert.equal(result.sources.filter((row) => row.selected).length, result.selectedCount);
  assert.match(result.limitations[0], /survivorship/);
});

test("rejects malformed, stale, and undersized cohorts instead of filling missing data", () => {
  const sources = Array.from({ length: 8 }, (_, i) => makeSource(i + 1, 0.001));
  assert.throws(() => runPointInTimeBacktest(sources.slice(0, 5), { cutoffMs: start + 16 * DAY, asOfMs: start + 30 * DAY }), /too small/);
  assert.throws(() => runPointInTimeBacktest([{ ...sources[0], month: { ...sources[0].month, pnlHistory: [] } }, ...sources.slice(1)], { cutoffMs: start + 16 * DAY, asOfMs: start + 30 * DAY }), /aligned/);
  assert.throws(() => runPointInTimeBacktest(sources, { cutoffMs: start + 7 * DAY, asOfMs: start + 30 * DAY }), /insufficient training/);
});

test("rejects duplicate identities and impossible bounds", () => {
  const sources = Array.from({ length: 8 }, (_, i) => makeSource(i + 1, 0.001));
  assert.throws(() => runPointInTimeBacktest([sources[0], { ...sources[1], address: sources[0].address }, ...sources.slice(2)], { cutoffMs: start + 16 * DAY, asOfMs: start + 30 * DAY }), /duplicate/);
  assert.throws(() => runPointInTimeBacktest(sources, { cutoffMs: start + 30 * DAY, asOfMs: start + 30 * DAY }), /bounds/);
});

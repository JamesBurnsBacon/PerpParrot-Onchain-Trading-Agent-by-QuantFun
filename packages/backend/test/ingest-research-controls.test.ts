import { expect, test } from "bun:test";
import { screenEvidence } from "../src/ingest/research-screen";
import { parsePortfolio, DEFAULT_CONFIG } from "../src/score";
import { analyse } from "../src/score/metrics";
import { dailyReturns, correlation } from "../src/score/clones";
import { digest } from "../src/ingest/store";
import type { Candidate } from "../src/ingest/types";

function sample(peakDay: number, n: number) {
  const start = Date.parse("2026-08-01T00:00:00Z"), day = 86_400_000;
  const address = `0x${n.toString(16).padStart(40, "0")}` as `0x${string}`;
  const nav = Array.from({ length: 31 }, (_, i) => i < peakDay ? 1 : i === peakDay ? 1.5 : 1.2);
  const accountValueHistory = nav.map((v, i) => [start + i * day, String(v * 10_000)]);
  const pnlHistory = nav.map((v, i) => [start + i * day, String((v - 1) * 10_000)]);
  const raw = JSON.stringify(["month", "allTime"].map(name => [name, { vlm: "100000", accountValueHistory, pnlHistory }]));
  const candidate: Candidate = { address, accountValueOrTvlUsd: "12000", valueSource: "leaderboard-account-value", sources: ["leaderboard"], name: null, knownHypercoreVault: false, leaderAddress: null };
  const row = screenEvidence({ address, raw, sha256: digest(raw), fetchedAt: new Date(start + 30 * day).toISOString() }, candidate, start + 30 * day);
  const input = { address, kind: "trader", accountValue: 12000, closed: false, tradeCount: 10, ...parsePortfolio(JSON.parse(raw)), history: null } as const;
  return { four: [row.bestStage!.return, row.observation!.return, row.observation!.maxDrawdown, row.bestStage!.maxDrawdown],
    returns: dailyReturns(analyse(input, DEFAULT_CONFIG)!) };
}

test("a duplicated series produces identical metrics and correlation one", () => {
  const a = sample(5, 1), b = sample(5, 2);
  expect(a.four).toEqual(b.four); expect(correlation(a.returns, b.returns, 20)).toBe(1);
});
test("four identical summary metrics do not establish correlated daily returns", () => {
  const a = sample(5, 1), b = sample(20, 2);
  expect(a.four).toEqual(b.four); expect(correlation(a.returns, b.returns, 20)).toBeCloseTo(-0.005199934972383163, 10);
});

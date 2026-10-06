import assert from "node:assert/strict";
import test from "node:test";
import { deriveSourceFeatures, spearman } from "../../src/backtest/source-features";

const ACCOUNT = "0x0000000000000000000000000000000000000001";
const OTHER = "0x0000000000000000000000000000000000000002";
const common = { address: ACCOUNT, startMs: 100, cutoffMs: 200, startingEquity: 10_000 };

test("derives fill, fee, concentration, funding and transfer features with null-safe units", () => {
  const features = deriveSourceFeatures({
    ...common,
    evidence: {
      userFillsByTime: [
        { time: 120, tid: 1, coin: "BTC", px: "100", sz: "10", fee: "0.5", feeToken: "USDC", crossed: false },
        { time: 140, tid: 2, coin: "ETH", px: "50", sz: "10", fee: "0.75", feeToken: "USDC", crossed: true },
        { time: 140, tid: 2, coin: "ETH", px: "50", sz: "10", fee: "0.75", feeToken: "USDC", crossed: true },
        { time: 180, tid: 3, coin: "#21961", px: "0.0", sz: "1", fee: "0", feeToken: "USDC", crossed: true, dir: "Settlement", closedPnl: "-20" },
      ],
      userFunding: [{ time: 150, hash: "h", delta: { coin: "BTC", usdc: "-2", szi: "1" } }],
      userNonFundingLedgerUpdates: [
        { time: 160, hash: "in", delta: { type: "send", user: OTHER, destination: ACCOUNT, usdcValue: "100" } },
        { time: 170, hash: "out", delta: { type: "send", user: ACCOUNT, destination: OTHER, usdcValue: "25" } },
        { time: 170, hash: "deposit", delta: { type: "deposit", amount: "50" } },
      ],
    },
  });
  assert.equal(features.fillCount, 2);
  assert.equal(features.settlementCount, 1);
  assert.equal(features.settlementPnlPctEquity, -0.002);
  assert.equal(features.makerNotionalShare, 2 / 3);
  assert.ok(Math.abs(features.feeBpsOfNotional! - (1.25 / 1500 * 10_000)) < 1e-10);
  assert.ok(Math.abs(features.assetNotionalHhi! - 5 / 9) < 1e-10);
  assert.equal(features.netFundingPctEquity, -0.0002);
  assert.equal(features.ledgerEventCount, 3);
  assert.equal(features.distinctTransferCounterparties, 1);
  assert.equal(features.netTransferPctEquity, 0.0075);
});

test("preserves missing denominators and rejects events outside the frozen feature window", () => {
  const empty = { userFillsByTime: [], userFunding: [], userNonFundingLedgerUpdates: [] };
  const features = deriveSourceFeatures({ ...common, startingEquity: null, evidence: empty });
  assert.equal(features.logTurnoverToEquity, null);
  assert.equal(features.netFundingPctEquity, null);
  assert.equal(features.fillCount, 0);
  assert.throws(() => deriveSourceFeatures({
    ...common,
    evidence: { ...empty, userFillsByTime: [{ time: 99 }] },
  }), /outside requested/);
});

test("computes Spearman ranks with average ranks for ties", () => {
  assert.deepEqual(spearman([1, 2, 2, 4], [4, 2, 3, 1]), { n: 4, rho: -0.9486832980505138 });
  assert.deepEqual(spearman([1, null, 3], [1, 2, 3]), { n: 2, rho: null });
});

import type { Finalist } from "./agent";

// Spike fixture until the backend serves real finalists. Values are illustrative.
export const FIXTURE_FINALISTS: Finalist[] = [
  {
    id: "F01",
    kind: "trader",
    sortino30d: 3.1,
    calmar30d: 4.2,
    maxDrawdown30d: 0.08,
    pnlConsistency: 0.81,
    avgLeverage: 3.5,
    timeInMarket: 0.92,
    medianHoldHours: 30,
    makerShare: 0.2,
    equityCurve: [1, 1.02, 1.03, 1.05, 1.04, 1.07, 1.09, 1.12],
  },
  {
    id: "F02",
    kind: "hypercore-vault",
    sortino30d: 2.2,
    calmar30d: 2.9,
    maxDrawdown30d: 0.05,
    pnlConsistency: 0.88,
    avgLeverage: 1.8,
    timeInMarket: 0.99,
    medianHoldHours: 72,
    makerShare: 0.55,
    equityCurve: [1, 1.01, 1.02, 1.02, 1.03, 1.04, 1.05, 1.06],
  },
  {
    id: "F03",
    kind: "trader",
    sortino30d: 4.8,
    calmar30d: 1.1,
    maxDrawdown30d: 0.41,
    pnlConsistency: 0.34,
    avgLeverage: 22,
    timeInMarket: 0.35,
    medianHoldHours: 0.2,
    makerShare: 0.05,
    equityCurve: [1, 0.8, 0.7, 1.1, 0.75, 1.3, 0.9, 1.45],
  },
];

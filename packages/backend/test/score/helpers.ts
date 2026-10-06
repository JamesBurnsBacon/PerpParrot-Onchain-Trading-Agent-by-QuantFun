import { expect } from "bun:test";
import { parsePortfolio, type Kind, type ScoreInput, type TimePoint, type WindowHistory } from "../../src/score";
import sample from "../fixtures/score/portfolio-sample.json";

type RawWindow = { accountValueHistory: number[][]; pnlHistory: number[][] } | null;
export type RawInput = {
  address: string;
  kind: string;
  accountValue: number | string;
  closed: boolean | null;
  month: RawWindow;
  allTime: RawWindow;
  history: RawWindow;
  tradeCount: number | null;
  links?: string[];
  avgLeverage?: number | null;
  timeInMarket?: number | null;
  medianHoldHours?: number | null;
  makerShare?: number | null;
};

const toWindow = (raw: RawWindow): WindowHistory | null => raw === null ? null : {
  accountValueHistory: raw.accountValueHistory.map(([ts, value]): TimePoint => [ts, value]),
  pnlHistory: raw.pnlHistory.map(([ts, value]): TimePoint => [ts, value]),
};

const isKind = (kind: string): kind is Kind => kind === "trader" || kind === "hypercore-vault" || kind === "erc4626-vault";

// Fixture JSON cannot hold NaN, so a non-finite account value is the string "NaN" (fixtures README).
export const toInput = (raw: RawInput): ScoreInput => {
  if (!isKind(raw.kind)) throw new Error(`invalid fixture kind: ${raw.kind}`);
  if (typeof raw.accountValue === "string" && raw.accountValue !== "NaN") {
    throw new Error(`invalid fixture accountValue: ${raw.accountValue}`);
  }
  return {
    ...raw,
    kind: raw.kind,
    accountValue: raw.accountValue === "NaN" ? NaN : raw.accountValue as number,
    month: toWindow(raw.month),
    allTime: toWindow(raw.allTime),
    history: toWindow(raw.history),
  };
};

export const sampleInputs: ScoreInput[] = sample.map((entry): ScoreInput => ({
  address: entry.id,
  kind: "trader",
  accountValue: entry.accountValue,
  closed: entry.closed,
  tradeCount: entry.tradeCount,
  history: null,
  ...parsePortfolio(entry.portfolio),
}));

// Numbers within 1e-9 * max(1, |expected|); everything else, key sets and order exactly (fixtures README).
export const expectOutput = (actual: unknown, expected: unknown, path = "result"): void => {
  if (typeof expected === "number") {
    if (typeof actual !== "number") throw new Error(`${path}: expected number ${expected}, got ${JSON.stringify(actual)}`);
    expect(Math.abs(actual - expected), path).toBeLessThanOrEqual(1e-9 * Math.max(1, Math.abs(expected)));
  } else if (Array.isArray(expected)) {
    if (!Array.isArray(actual)) throw new Error(`${path}: expected array, got ${JSON.stringify(actual)}`);
    expect(actual.length, path).toBe(expected.length);
    expected.forEach((value: unknown, i: number) => expectOutput(actual[i], value, `${path}[${i}]`));
  } else if (expected !== null && typeof expected === "object") {
    if (actual === null || typeof actual !== "object" || Array.isArray(actual)) {
      throw new Error(`${path}: expected object, got ${JSON.stringify(actual)}`);
    }
    expect(Object.keys(actual).sort(), path).toEqual(Object.keys(expected).sort());
    for (const [key, value] of Object.entries(expected)) {
      expectOutput((actual as Record<string, unknown>)[key], value, `${path}.${key}`);
    }
  } else {
    expect(actual, path).toBe(expected);
  }
};

// Every number in an output is finite (SPEC "Metrics").
export const expectFinite = (value: unknown): void => {
  if (typeof value === "number") expect(Number.isFinite(value)).toBe(true);
  else if (value !== null && typeof value === "object") Object.values(value).forEach(expectFinite);
};

export const seededGenerator = (initialSeed: number): (() => number) => {
  let seed = initialSeed;
  return () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed;
  };
};

export const shuffle = <T>(items: T[], seed = 42): T[] => {
  const result = [...items];
  const next = seededGenerator(seed);
  for (let i = result.length - 1; i > 0; i--) {
    const j = next() % (i + 1);
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
};

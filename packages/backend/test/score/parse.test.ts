import { describe, expect, test } from "bun:test";
import { parsePortfolio } from "../../src/score";
import sample from "../fixtures/score/portfolio-sample.json";

const history = {
  accountValueHistory: [[0, "1000"], [86_400_000, "1010.5"]],
  pnlHistory: [[0, "0"], [86_400_000, "10.5"]],
};

describe("parsePortfolio", () => {
  test("has 24 sample entries", () => {
    expect(sample).toHaveLength(24);
  });

  for (const entry of sample) {
    test(`parses both windows for ${entry.id}`, () => {
      const result = parsePortfolio(entry.portfolio);
      for (const name of ["month", "allTime"] as const) {
        const window = result[name];
        expect(window).not.toBeNull();
        if (window === null) throw new Error(`missing ${name}`);
        const rawEntry = entry.portfolio.find(([windowName]) => windowName === name);
        if (!rawEntry || typeof rawEntry[1] !== "object") throw new Error(`missing raw ${name}`);
        for (const key of ["accountValueHistory", "pnlHistory"] as const) {
          const raw = rawEntry[1][key];
          expect(window[key]).toHaveLength(raw.length);
          window[key].forEach(([timestamp, value], i) => {
            const rawTimestamp = raw[i][0];
            if (typeof rawTimestamp !== "number") throw new Error("non-numeric fixture timestamp");
            expect(timestamp).toBe(rawTimestamp);
            expect(typeof value).toBe("number");
            expect(Number.isFinite(value)).toBe(true);
            expect(value).toBe(Number(raw[i][1]));
          });
        }
      }
    });
  }

  test("returns null for absent windows", () => {
    expect(parsePortfolio([])).toEqual({ month: null, allTime: null });
    expect(parsePortfolio([["month", history]]).allTime).toBeNull();
    expect(parsePortfolio([["allTime", history]]).month).toBeNull();
  });

  test("rejects a window that appears twice, whichever window it is (SPEC parsePortfolio)", () => {
    for (const name of ["month", "allTime", "day"]) {
      expect(() => parsePortfolio([[name, history], ["week", history], [name, history]]))
        .toThrow(`portfolio: duplicate window ${name}`);
    }
  });

  test("ignores other window names", () => {
    const names = ["day", "week", "perpMonth", "perpAllTime", "perpDay", "Month", "alltime"];
    expect(parsePortfolio(names.map((name) => [name, {}]))).toEqual({ month: null, allTime: null });
  });

  test("leaves ordering and alignment to series validation (SPEC parsePortfolio)", () => {
    expect(parsePortfolio([["month", {
      accountValueHistory: [[2, "1"], [1, "2"]],
      pnlHistory: [[3, "0"]],
    }]]).month).toEqual({ accountValueHistory: [[2, 1], [1, 2]], pnlHistory: [[3, 0]] });
  });

  const malformed: { name: string; raw: unknown }[] = [
    ...[null, {}, "month", 1].map((raw) => ({ name: `non-array ${String(raw)}`, raw })),
    ...[null, {}, [], ["month"], [1, history], ["month", null], ["month", []], ["month", history, 0]]
      .map((entry, i) => ({ name: `bad entry ${i}`, raw: [entry] })),
    { name: "missing histories", raw: [["month", {}]] },
    { name: "non-array history", raw: [["month", { ...history, pnlHistory: {} }]] },
    ...["abc", "NaN", "Infinity", "-Infinity", "", " ", "9".repeat(400), 1, null]
      .map((value) => ({ name: `bad value ${String(value)}`, raw: [["month", { ...history, pnlHistory: [[0, value]] }]] })),
    ...[0.5, "0", NaN, Infinity, -Infinity]
      .map((timestamp) => ({ name: `bad timestamp ${String(timestamp)}`, raw: [["month", { ...history, pnlHistory: [[timestamp, "0"]] }]] })),
    ...[null, [0], [0, "1", "2"]]
      .map((point, i) => ({ name: `bad point ${i}`, raw: [["month", { ...history, accountValueHistory: [point] }]] })),
  ];
  for (const { name, raw } of malformed) {
    test(`rejects ${name}`, () => {
      expect(() => parsePortfolio(raw)).toThrow(/^portfolio:/);
    });
  }
});

import { describe, expect, test } from "bun:test";
import { scoreCandidates, toFrameCandidates } from "../../src/score";
import { sampleInputs } from "./helpers";

describe("toFrameCandidates (SPEC Frame adapter)", () => {
  const result = scoreCandidates(sampleInputs, { allowUnknown: ["minTrades"] });
  const frame = toFrameCandidates(result);

  test("one frame candidate per finalist, indexed by finalist position", () => {
    expect(frame.candidates.map(({ candidate }) => candidate)).toEqual(result.finalists.map((_, i) => i));
  });

  test("maps Score fields and never fills the out-of-sample fields", () => {
    frame.candidates.forEach((entry, i) => {
      const source = result.candidates.find(({ address }) => address === result.finalists[i])!;
      const metrics = source.metrics!;
      expect(entry.kind).toBe("TRADER");
      expect(entry.clones).toEqual(source.clones);
      expect(entry.metrics).toMatchObject({
        historyDays: Math.floor(source.activeDays!),
        maxDrawdown: metrics.maxDrawdown!,
        pnlConsistency: metrics.consistency ?? 0,
        isSharpe: metrics.sharpe === "+inf" ? null : metrics.sharpe,
        isSortino: metrics.sortino === "+inf" ? null : metrics.sortino,
        isCalmar: metrics.calmar === "+inf" ? null : metrics.calmar,
        lookbackDays: metrics.lookbackDays,
        scoreFlags: metrics.flags,
        oosWindows: 0,
        oosSharpe: null,
        oosSortino: null,
        oosMaxDrawdown: null,
        crossWindowStability: null,
      });
    });
  });

  test("pairs carry finalist positions and the clone-step correlations", () => {
    expect(frame.pairs).toHaveLength(result.correlations.length);
    frame.pairs.forEach((pair, i) => {
      const source = result.correlations[i];
      expect(result.finalists[pair.a]).toBe(source.a);
      expect(result.finalists[pair.b]).toBe(source.b);
      expect(pair.a).toBeLessThan(pair.b);
      expect(pair.correlation).toBe(source.rho);
      expect(pair.linkedSource).toBe(source.linked);
    });
  });

  test("reports unknown-history finalists in order, drops their pairs and renumbers kept positions", () => {
    const omitted = [result.finalists[0], result.finalists[2]];
    const patched = {
      ...result,
      candidates: result.candidates.map((c) => omitted.includes(c.address) ? { ...c, activeDays: null } : c),
    };
    const actual = toFrameCandidates(patched);
    const kept = result.finalists.filter((address) => !omitted.includes(address));
    expect(actual.skipped).toEqual(omitted.map((address) => ({ address, reason: "unknown-history" })));
    expect(actual.candidates).toEqual(frame.candidates
      .filter((_, i) => !omitted.includes(result.finalists[i]))
      .map((candidate, i) => ({ ...candidate, candidate: i })));
    expect(actual.pairs).toEqual(result.correlations
      .filter(({ a, b }) => !omitted.includes(a) && !omitted.includes(b))
      .map(({ a, b, rho, linked }) => ({ a: kept.indexOf(a), b: kept.indexOf(b), correlation: rho, linkedSource: linked })));
  });

  test("all finalists with unknown history leave no candidates or pairs", () => {
    const actual = toFrameCandidates({
      ...result,
      candidates: result.candidates.map((c) => ({ ...c, activeDays: null })),
    });
    expect(actual.candidates).toEqual([]);
    expect(actual.pairs).toEqual([]);
    expect(actual.skipped).toEqual(result.finalists.map((address) => ({ address, reason: "unknown-history" })));
  });

  for (const [activeDays, historyDays] of [[726.32, 726], [30, 30]]) {
    test(`historyDays floors ${activeDays} to ${historyDays}`, () => {
      const actual = toFrameCandidates({
        ...result,
        candidates: result.candidates.map((c) => ({ ...c, activeDays })),
      });
      expect(actual.candidates.map(({ metrics }) => metrics.historyDays)).toEqual(result.finalists.map(() => historyDays));
      expect(actual.skipped).toEqual([]);
    });
  }

  test("a hand-built finalist with null maxDrawdown fails closed", () => {
    const [finalist] = result.finalists;
    const patched = {
      ...result,
      candidates: result.candidates.map((c) => c.address !== finalist ? c : {
        ...c, metrics: { ...c.metrics!, maxDrawdown: null },
      }),
    };
    expect(() => toFrameCandidates(patched)).toThrow(`frame: finalist without metrics: ${finalist}`);
  });

  test("hold time converts to minutes and +inf ratios become null", () => {
    const [finalist] = result.finalists;
    const patched = {
      ...result,
      candidates: result.candidates.map((c) => c.address !== finalist ? c : {
        ...c,
        passthrough: { ...c.passthrough, medianHoldHours: 1.5 },
        metrics: { ...c.metrics!, sharpe: "+inf" as const },
      }),
    };
    const [entry] = toFrameCandidates(patched).candidates;
    expect(entry.metrics.medianHoldMinutes).toBe(90);
    expect(entry.metrics.isSharpe).toBeNull();
  });
});

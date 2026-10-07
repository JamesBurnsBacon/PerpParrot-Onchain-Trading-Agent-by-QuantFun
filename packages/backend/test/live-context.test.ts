import { expect, test } from "bun:test";
import { appendContextFacts, buildLiveContext, type LiveContextDeps } from "../src/live/context";
import { defaultBooks } from "../src/paper/service";

const DAY = 86_400;
const deps = (): LiveContextDeps => ({ activeSources: async () => ["0xAB", "0xab", "0xCD"],
  paperPoints: async () => [{ bookId: "aggressive-470", t: 0, equityUsd: 100 }, { bookId: "aggressive-470", t: 12 * DAY, equityUsd: 104.2 }],
  liveExposures: async () => [{ asset: "BTC", fraction: -.4 }, { asset: "ETH", fraction: .9 }, { asset: "SOL", fraction: .3 }, { asset: "HYPE", fraction: -.2 }],
  log: () => {},
});
test("overlap counts unique lowercase addresses in both sets", async () => {
  const result = await buildLiveContext(deps(), ["0xab", "0xAB", "0xcd", "0xEF", "0xef"]);
  expect(result.compare).toEqual({ total: 3, existing: 2, new: 1 });
  expect(result.facts).toContain("2 of these 3 wallets are already in the live book; 1 are new.");
});
test("paper uses ordered first and last points, not starting capital or intermediate peaks", async () => {
  const d = deps();
  d.paperPoints = async () => [{ bookId: "aggressive-470", t: 12 * DAY, equityUsd: 104.2 },
    { bookId: "aggressive-470", t: 6 * DAY, equityUsd: 900 }, { bookId: "aggressive-470", t: 0, equityUsd: 100 }];
  const c = await buildLiveContext(d, []);
  expect(c.paper).toEqual([{ bookId: "aggressive-470", label: "aggressive-470", returnPct: 4.2, days: 12 }]);
  expect(c.facts.join(" ")).toContain("existing paper book replay, not this shortlist or a forecast");
});
test("paper lists the three live-size copy books (no $10k twins) and ignores unknown and BTC books", async () => {
  const d = deps();
  d.paperPoints = async () => [...defaultBooks().map(b => b.id), "made-up"].flatMap(bookId => [
    { bookId, t: DAY, equityUsd: 80 }, { bookId, t: 0, equityUsd: 100 }]);
  expect((await buildLiveContext(d, [])).paper).toEqual(["aggressive-470", "balanced-470", "conservative-470"].map(bookId =>
    ({ bookId, label: bookId, returnPct: -20, days: 1 })));
});
test("paper needs two points and a positive start, and never emits nonfinite results", async () => {
  for (const rows of [[], [{ t: 0, equityUsd: 100 }], [{ t: 0, equityUsd: 0 }, { t: DAY, equityUsd: 100 }],
    [{ t: 0, equityUsd: -5 }, { t: DAY, equityUsd: 100 }], [{ t: 0, equityUsd: 1e-300 }, { t: DAY, equityUsd: 1e300 }]]) {
    const d = deps(); d.paperPoints = async () => rows.map(p => ({ ...p, bookId: "aggressive-470" }));
    expect((await buildLiveContext(d, [])).paper).toBeUndefined();
  }
});
test("exposures gross includes all assets; top three sort by absolute fraction", async () => {
  const c = await buildLiveContext(deps(), []);
  expect(c.book).toEqual({ gross: 1.8, top: [{ asset: "ETH", fraction: .9 }, { asset: "BTC", fraction: -.4 }, { asset: "SOL", fraction: .3 }] });
  expect(c.facts.join(" ")).toContain("gross 1.8x; top ETH long 0.9x, BTC short 0.4x, SOL long 0.3x");
});
test("missing reads omit their parts, empty known book is flat, and no input is changed", async () => {
  const missing = await buildLiveContext({ activeSources: async () => null, paperPoints: async () => [], liveExposures: async () => null }, []);
  expect(missing).toEqual({ facts: [] });
  const d = deps(); d.activeSources = async () => []; d.liveExposures = async () => [];
  expect(await buildLiveContext(d, [])).toMatchObject({ compare: { total: 0, existing: 0, new: 0 }, book: { gross: 0, top: [] } });
  const rows = Object.freeze([{ asset: "BTC", fraction: -.4 }, { asset: "ETH", fraction: .9 }]);
  d.liveExposures = async () => rows as unknown as { asset: string; fraction: number }[];
  await buildLiveContext(d, []); expect(rows[0].asset).toBe("BTC");
});
for (const [dep, part] of [["activeSources", "compare"], ["paperPoints", "paper"], ["liveExposures", "book"]] as const) {
  test(`per-dep failure isolation: ${dep}`, async () => {
    const d = deps(), logs: string[] = []; d.log = m => { logs.push(m); };
    d[dep] = () => { throw new Error("private failure"); };
    const c = await buildLiveContext(d, ["0xab"]);
    expect(c[part]).toBeUndefined();
    for (const other of ["compare", "paper", "book"] as const) if (other !== part) expect(c[other]).toBeDefined();
    expect(logs).toHaveLength(1); expect(logs[0]).not.toContain("private failure");
  });
  test(`per-dep timeout isolation: ${dep}`, async () => {
    const d = deps(), logs: string[] = []; d.log = m => { logs.push(m); };
    d[dep] = () => new Promise<never>(() => {});
    const start = performance.now();
    const c = await buildLiveContext(d, ["0xab"]);
    expect(performance.now() - start).toBeGreaterThanOrEqual(1900);
    expect(performance.now() - start).toBeLessThan(3500);
    expect(c[part]).toBeUndefined();
    for (const other of ["compare", "paper", "book"] as const) if (other !== part) expect(c[other]).toBeDefined();
    expect(logs).toHaveLength(1);
  });
}
test("reads start in parallel and failed logging never rejects context", async () => {
  const calls: string[] = [];
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const c = buildLiveContext({
    activeSources: async () => { calls.push("active"); await gate; return []; },
    paperPoints: async () => { calls.push("paper"); await gate; throw new Error(); },
    liveExposures: async () => { calls.push("book"); await gate; return []; }, log: () => { throw new Error(); },
  }, []);
  await Promise.resolve(); expect(calls).toEqual(["active", "paper", "book"]); release();
  expect(await c).toMatchObject({ compare: { total: 0 }, book: { gross: 0 } });
});
test("1200-char cap drops context first and retains all existing facts", async () => {
  const c = await buildLiveContext(deps(), ["0xab"]);
  expect(c.facts.join(" ").length).toBeLessThanOrEqual(1200);
  const base = "B".repeat(1170);
  expect(appendContextFacts(base, [...c.facts, "fits"])).toBe(`${base} fits`);
  expect(appendContextFacts("B".repeat(1198), ["extra"])).toHaveLength(1198);
  expect(appendContextFacts("B".repeat(1200), c.facts)).toHaveLength(1200);
  expect(appendContextFacts("B".repeat(1198), ["x"])).toHaveLength(1200);
});
test("context module has no persistence or execution calls", async () => {
  const source = await Bun.file(new URL("../src/live/context.ts", import.meta.url)).text();
  expect(source).not.toMatch(/\b(insert|update|delete|upsert|alter|drop|truncate)\b/i);
  expect(source).not.toMatch(/\.(save|write|step|putIfAbsent|execute|fetch)\s*\(/);
});

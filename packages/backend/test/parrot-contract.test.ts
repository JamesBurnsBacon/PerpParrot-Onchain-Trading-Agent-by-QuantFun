import { expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { shortlist, type StrategyIntent } from "../../shared/strategy-intent";
import { selectStrategy, explainSelection } from "../src/chat/strategy";
import { buildPreview } from "../src/chat/preview";
import { loadFinalists } from "../src/chat/finalists";
import { intents } from "../scripts/measure-wallet-board";
import fixture from "../fixtures/frozen-configuration.json";
import type { Policy } from "../../shared/src/contracts";

const base = fixture.policy as Policy;

test("the retired shared/parrot-intent module cannot return or be imported", () => {
  const root = resolve(import.meta.dir, "../../..");
  const retired = "shared/parrot-intent";
  expect(existsSync(resolve(root, "packages", `${retired}.ts`))).toBe(false);
  const result = Bun.spawnSync(["git", "ls-files", "-z", "--cached", "--others", "--exclude-standard", "packages"], { cwd: root });
  expect(result.exitCode).toBe(0);
  const paths = result.stdout.toString().split("\0").filter(p => /\.(?:[cm]?[jt]sx?)$/.test(p) && existsSync(resolve(root, p)));
  expect(paths.length).toBeGreaterThan(100);
  const imports = /(?:from\s*|import\s*(?:\(\s*)?|require\s*\(\s*)["']([^"']+)["']/g;
  expect(paths.filter(p => [...readFileSync(resolve(root, p), "utf8").matchAll(imports)]
    .some(m => m[1].includes(retired)))).toEqual([]);
});

test("parrot selector uses main ordering and the conservative 2M window over contract fields", async () => {
  const data = await loadFinalists();
  const rows = data.finalists.map(({ address, kind, score, flags, maxDrawdown, realizedVol, cloneOf }) =>
    ({ address, kind, score, flags, maxDrawdown, realizedVol, cloneOf }));
  for (const riskStyle of ["aggressive", "balanced", "conservative"] as const) {
    for (const maxSources of [6, 12, 25]) {
      const intent = { ...intents.balanced, riskStyle, maxSources };
      const m = riskStyle === "conservative" ? Math.min(25, Math.ceil(1.2 * maxSources)) : maxSources;
      const selected = selectStrategy(intent, base, data);
      expect(selected.shortlist.addresses).toEqual(shortlist(rows, { ...intent, maxSources: m }, m).slice(0, maxSources));
      expect(selected.policy).toEqual({ changes: [], clamps: [], maxSources });
    }
  }
  const aggressive = selectStrategy(intents['aggressive/many'], base, data).shortlist.addresses;
  const conservative = selectStrategy(intents['safe/few'], base, data).shortlist.addresses;
  expect(conservative.filter(a => !aggressive.includes(a))).toHaveLength(2);
});

test("parrot preview preserves every base limit and always simulates", async () => {
  const data = await loadFinalists();
  const tight = { ...base, maxSourceWeight: .08, cashBuffer: .4000001, maxGrossLeverage: .8,
    maxPairCorrelation: .3, maxExposureOverlap: .2 };
  for (const riskStyle of ["aggressive", "balanced", "conservative"] as const) {
    const intent: StrategyIntent = { ...intents.requestedLeverage, riskStyle, maxSources: 25, requestedLeverage: 100 };
    const { policy, shortlist: { addresses } } = selectStrategy(intent, tight, data);
    const preview = buildPreview({ intent, basePolicy: tight, addresses });
    expect(preview.policy).toEqual({ ...tight, mode: "SIMULATION" });
    expect(preview.policy.mode).toBe("SIMULATION");
    expect(preview.policy.cashBuffer).toBeGreaterThanOrEqual(tight.cashBuffer);
    for (const field of ["maxGrossLeverage", "maxSourceWeight", "maxPairCorrelation", "maxExposureOverlap"] as const)
      expect(preview.policy[field]).toBeLessThanOrEqual(tight[field]);
    expect(policy).toEqual({ changes: [], clamps: [], maxSources: 25 });
    expect(preview.cashUnits).toBe(400001);
    expect(preview.sources.reduce((n, s) => n + s.weightUnits, preview.cashUnits)).toBe(1_000_000);
    expect(Object.keys(preview).sort()).toEqual(["approvalRequired", "cashUnits", "policy", "previewHash", "sources", "version", "weighting"]);
    expect(buildPreview({ intent, basePolicy: tight, addresses })).toEqual(preview);
  }
});

test("clone evidence unknown is excluded and reasons match selection in every style", async () => {
  const data = await loadFinalists();
  const unknown = { ...data.finalists.find(f => f.score !== null && !f.cloneOf)!, score: 1000, maxDrawdown: 0, realizedVol: 0, cloneOf: null };
  const changed = { ...data, finalists: data.finalists.map(f => f.address === unknown.address ? unknown : f) };
  for (const riskStyle of ["aggressive", "balanced", "conservative"] as const) {
    const intent = { ...intents.balanced, riskStyle, maxSources: 25 };
    expect(selectStrategy(intent, base, changed).shortlist.addresses).not.toContain(unknown.address);
    expect(explainSelection(intent, base, changed, [unknown.address]).changes!.removed)
      .toEqual([{ address: unknown.address, reason: "clone excluded" }]);
    expect(selectStrategy({ ...intent, avoidClones: false }, base, changed).shortlist.addresses).toContain(unknown.address);
  }
});

import { expect, test } from "bun:test";
import { keccak256, stringToBytes } from "viem";
import { buildPreview, PreviewError } from "../src/chat/preview";
import { intentToPolicy, type StrategyIntent } from "../../shared/parrot-intent";
import type { Policy } from "../../shared/src/contracts";
import { commitment } from "../../shared/commitments";
import fixture from "../fixtures/frozen-configuration.json";

const intent: StrategyIntent = { riskStyle: "aggressive", maxSources: 25, diversification: "low", leverageComfort: "high", requestedLeverage: null, avoidClones: false, horizon: "medium", clarify: null, reply: "Squawk." };
const base = fixture.policy as Policy;
const addresses = (n: number) => Array.from({ length: n }, (_, i) => `source-${i}`);

test.each([0, 0.1, 0.2, 0.333333, 0.35])("integer allocation for all N, cash %s", (cashBuffer) => {
  const policyResult = intentToPolicy(intent, { ...base, cashBuffer });
  for (let n = 5; n <= 25; n++) {
    const preview = buildPreview({ intent, policyResult, addresses: addresses(n) });
    expect(preview.cashUnits + preview.sources.reduce((sum, s) => sum + s.weightUnits, 0)).toBe(1_000_000);
    const rest = 1_000_000 - preview.cashUnits;
    preview.sources.forEach((s, i) => {
      expect(s.weightUnits).toBe(Math.floor(rest / n) + (i < rest % n ? 1 : 0));
      expect(s.weightUnits).toBeLessThanOrEqual(s.ceilingUnits);
      expect(s.ceilingUnits).toBe(Math.floor(policyResult.policy.maxSourceWeight * 1_000_000));
    });
  }
});

test("source bounds and infeasible integer ceiling fail closed", () => {
  const policyResult = intentToPolicy(intent, base);
  for (const n of [0, 4, 26]) expect(() => buildPreview({ intent, policyResult, addresses: addresses(n) })).toThrow(new PreviewError("too_few_sources"));
  expect(() => buildPreview({ intent, policyResult: { ...policyResult, policy: { ...base, maxSourceWeight: 0.01 } }, addresses: addresses(5) })).toThrow();
});

test("stable hash binds intent, policy, sources, order and weights; distinct domain", () => {
  const policyResult = intentToPolicy(intent, base);
  const args = { intent, policyResult, addresses: addresses(7) };
  const preview = buildPreview(args);
  expect(buildPreview(args)).toEqual(preview);
  expect(preview).toMatchObject({ version: "1", liveEligible: true, paperOnly: false, weighting: "equal (preview only)" });
  for (const changed of [
    { ...args, intent: { ...intent, horizon: "short" as const } },
    { ...args, addresses: [...addresses(6), "other"] },
    { ...args, addresses: addresses(7).reverse() },
    { ...args, policyResult: { ...policyResult, policy: { ...base, cashBuffer: 0.2 } } },
    { ...args, policyResult: { ...policyResult, policy: { ...base, maxGrossLeverage: 2 } } },
  ]) expect(buildPreview(changed).previewHash).not.toBe(preview.previewHash);
  const payload = { version: preview.version, intent, policy: preview.policy, sources: preview.sources, cashUnits: preview.cashUnits };
  const hash = (s: string) => keccak256(stringToBytes(s));
  expect(preview.previewHash).toBe(commitment(hash, "perpparrot:parrot-preview:v1", payload));
  expect(preview.previewHash).not.toBe(commitment(hash, "perpparrot:frozen:v1", payload));
});


test("review-6: random cash minima round up with exact totals ceilings and stable hashes", () => {
  let seed = 2397;
  const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 2 ** 32; };
  for (let i = 0; i < 1000; i++) {
    const cashBuffer = i === 0 ? 0.1000004 : 0.1 + random() * 0.25;
    const n = 5 + Math.floor(random() * 21);
    const minCeiling = Math.ceil((1_000_000 - Math.ceil(cashBuffer * 1_000_000)) / n);
    const maxSourceWeight = (minCeiling + 1 + Math.floor(random() * 1000)) / 1_000_000;
    const policyResult = { ...intentToPolicy(intent, base), policy: { ...base, cashBuffer, maxSourceWeight } };
    const args = { intent, policyResult, addresses: addresses(n) };
    const preview = buildPreview(args);
    expect(preview.cashUnits / 1_000_000).toBeGreaterThanOrEqual(cashBuffer);
    expect(preview.cashUnits + preview.sources.reduce((sum, s) => sum + s.weightUnits, 0)).toBe(1_000_000);
    for (const source of preview.sources) {
      expect(source.weightUnits).toBeLessThanOrEqual(source.ceilingUnits);
      expect(source.weightUnits / 1_000_000).toBeLessThanOrEqual(maxSourceWeight);
    }
    expect(buildPreview(args).previewHash).toBe(preview.previewHash);
  }
});

import { expect, test } from "bun:test";
import { keccak256, stringToBytes } from "viem";
import { buildPreview, PreviewError } from "../src/chat/preview";
import { intentToPolicy, type StrategyIntent } from "../../shared/strategy-intent";
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

// Writes fixtures/frozen-configuration.json: a frozen configuration in the review
// core's format (branch ai-agent-workflow, shared/src/frozen.ts proposeFreeze()),
// for simulation and tests. Sources are 6 large open HL vaults with live positions
// on 2026-10-06; the account is the staging stand-in from mirror/config.staging.json.
// The real configuration comes from the review core's freeze at go-live.
// Run: bun run scripts/make-fixture-configuration.ts
import { commitment } from "../../shared/commitments";
import { WEIGHT_UNITS, type FrozenConfiguration } from "../../shared/frozen";
import { keccakUtf8 } from "../src/snapshot";

const policy = {
  bucket: "BALANCED",
  mode: "LIVE",
  capitalUsd: 470,
  minOrderUsd: 10,
  minExecutableTargets: 3,
  maxSourceWeight: 0.25,
  maxGrossLeverage: 3,
  cashBuffer: 0.1,
  maxPairCorrelation: 0.8,
  maxExposureOverlap: 0.5,
  minHistoryDays: 30,
  maxFrameAgeMs: 3_600_000,
  minExecutionFit: 50,
  riskRejectThreshold: 80,
  riskWatchThreshold: 60,
  minConfidence: 60,
  redTeamRebuildThreshold: 70,
  redTeamExcludeThreshold: 85,
};

const weights: [string, number][] = [
  ["0x1e37a337ed460039d1b15bd3bc489de789768d5e", 0.2],
  ["0xc179e03922afe8fa9533d3f896338b9fb87ce0c8", 0.15],
  ["0x07fd993f0fa3a185f7207adccd29f7a87404689d", 0.15],
  ["0x53f8f390fd4f70941c5d160a964f6893c8dbceff", 0.1],
  ["0x654016a8c9fcf0c4cb7ed6078aba21f7f399f7b7", 0.1],
  ["0xd6e56265890b76413d1d527eb9b75e334c0c5b42", 0.1],
];

// As proposeFreeze(): weights quantized down to millionths, residual to cash.
const sources = weights.map(([sourceAddress, weight], candidate) => ({
  candidate,
  sourceAddress,
  weightUnits: Math.floor(weight * WEIGHT_UNITS),
  ceilingUnits: Math.floor(0.25 * WEIGHT_UNITS),
}));
const payload: Omit<FrozenConfiguration, "configurationHash"> = {
  schemaVersion: "1.0.0",
  account: "0x010461c14e146ac35fe42271bdc1134ee31c703a",
  chainId: 999,
  frozenAtMs: Date.parse("2026-10-06T00:00:00Z"),
  reviewHash: `0x${"5a".repeat(32)}`,
  policy,
  policyHash: commitment(keccakUtf8, "perpparrot:policy:v1", policy),
  sources,
  cashUnits: WEIGHT_UNITS - sources.reduce((sum, s) => sum + s.weightUnits, 0),
};
const configuration = { ...payload, configurationHash: commitment(keccakUtf8, "perpparrot:frozen:v1", payload) };

await Bun.write(new URL("../fixtures/frozen-configuration.json", import.meta.url), `${JSON.stringify(configuration, null, 2)}\n`);
console.log(configuration.configurationHash);

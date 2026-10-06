// Writes fixtures/frozen-configuration.json: a frozen configuration in the review
// core's format (branch ai-agent-workflow, shared/src/frozen.ts proposeFreeze()),
// for simulation and tests. Sources (live positions on 2026-10-06) cover every HL
// account mode: 4 large open vaults (standard), 2 leaderboard traders in unified mode
// and 1 in portfolio margin, the last 3 holding xyz (HIP-3) positions. The account is
// a stand-in for ours (a large vault) until our wallet exists.
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
  maxSourceWeight: 0.3,
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
  ["0x1e37a337ed460039d1b15bd3bc489de789768d5e", 0.15], // vault, standard
  ["0xc179e03922afe8fa9533d3f896338b9fb87ce0c8", 0.1], // vault, standard
  ["0x07fd993f0fa3a185f7207adccd29f7a87404689d", 0.1], // vault, standard
  ["0x53f8f390fd4f70941c5d160a964f6893c8dbceff", 0.1], // vault, standard
  ["0xfd4d5751b60a7a7a67bd6fd0aa72dc7d704abce1", 0.1], // trader, unified, xyz
  ["0x1b9a49c3797b12f3b913a963cca7460d751b1073", 0.1], // trader, unified, xyz
  ["0xa2ce35322f09280e98f104f955b1bce3cfa11fa9", 0.1], // trader, portfolio margin, xyz
];

// As proposeFreeze(): weights quantized down to millionths, residual to cash.
const sources = weights.map(([sourceAddress, weight], candidate) => ({
  candidate,
  sourceAddress,
  weightUnits: Math.floor(weight * WEIGHT_UNITS),
  ceilingUnits: Math.floor(0.3 * WEIGHT_UNITS),
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

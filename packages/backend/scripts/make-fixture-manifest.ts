// Writes fixtures/manifest.json: a VALID/LIVE manifest in the review core's format
// (branch ai-agent-workflow, bucket-manifest.schema.json) for simulation and tests.
// Sources are 6 large open HL vaults with live positions on 2026-10-06; the real
// manifest comes from the review core at go-live. Run: bun run scripts/make-fixture-manifest.ts
import { commitment, manifestCommitment, type Manifest } from "../../shared/manifest";
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

const sources = [
  ["0x1e37a337ed460039d1b15bd3bc489de789768d5e", 0.2],
  ["0xc179e03922afe8fa9533d3f896338b9fb87ce0c8", 0.15],
  ["0x07fd993f0fa3a185f7207adccd29f7a87404689d", 0.15],
  ["0x53f8f390fd4f70941c5d160a964f6893c8dbceff", 0.1],
  ["0x654016a8c9fcf0c4cb7ed6078aba21f7f399f7b7", 0.1],
  ["0xd6e56265890b76413d1d527eb9b75e334c0c5b42", 0.1],
] as const;

const createdAtMs = Date.parse("2026-10-06T00:00:00Z");
const unsigned: Omit<Manifest, "manifestHash"> = {
  schemaVersion: "1.0.0",
  snapshotHash: `0x${"5a".repeat(32)}`,
  policyHash: commitment(keccakUtf8, "perpparrot:policy:v1", policy),
  createdAtMs,
  expiresAtMs: createdAtMs + 14 * 24 * 3600 * 1000,
  bucket: "BALANCED",
  mode: "LIVE",
  status: "VALID",
  rebuildCount: 0,
  policy,
  sources: sources.map(([sourceAddress, weight], candidate) => ({ candidate, sourceAddress, weight, maxAllocation: 0.25 })),
  cashWeight: 0.2,
  reason: "OK",
};
const manifest = { ...unsigned, manifestHash: manifestCommitment(keccakUtf8, unsigned as Manifest) };

await Bun.write(new URL("../fixtures/manifest.json", import.meta.url), `${JSON.stringify(manifest, null, 2)}\n`);
console.log(manifest.manifestHash);

// The frozen live manifest from the review core (branch ai-agent-workflow:
// packages/shared/src/contracts.ts `Manifest`, authorization.ts
// `requireFrozenLiveManifest`). It is the mirror's only execution authority.
//
// Dependency-free so the CRE workflow (WASM, no Ajv) can use it: callers pass
// keccak256 over UTF-8. The commitment format must stay byte-identical to
// shared/src/commitments.ts: keccak256(UTF8(JCS({domain, payload}))).

export type ManifestSource = {
  candidate: number;
  sourceAddress: string;
  weight: number;
  maxAllocation: number;
};

export type Manifest = {
  schemaVersion: "1.0.0";
  snapshotHash: string;
  policyHash: string;
  manifestHash: string;
  createdAtMs: number;
  expiresAtMs: number;
  bucket: "CONSERVATIVE" | "BALANCED" | "AGGRESSIVE";
  mode: "LIVE" | "SIMULATION";
  status: "VALID" | "INVALID_BUCKET";
  rebuildCount: 0 | 1;
  policy: Record<string, unknown> & {
    bucket: string;
    mode: string;
    maxSourceWeight: number;
    maxGrossLeverage: number;
    cashBuffer: number;
  };
  sources: ManifestSource[];
  cashWeight: number;
  reason: string;
};

export type KeccakUtf8 = (text: string) => string;

// RFC 8785-style canonical JSON, as in shared/src/commitments.ts canonicalize().
export const canonicalize = (value: unknown): string => {
  if (value === null || typeof value !== "object") {
    if (typeof value === "number" && !Number.isFinite(value)) throw new Error("nonfinite JSON number");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalize(object[key])}`)
    .join(",")}}`;
};

export const commitment = (keccakUtf8: KeccakUtf8, domain: string, payload: unknown): string => {
  if (!/^perpparrot:[a-z-]+:v1$/.test(domain)) throw new Error("invalid commitment domain");
  return keccakUtf8(canonicalize({ domain, payload }));
};

export const manifestCommitment = (keccakUtf8: KeccakUtf8, manifest: Manifest): string => {
  const { manifestHash: _, ...payload } = manifest;
  return commitment(keccakUtf8, "perpparrot:manifest:v1", payload);
};

const ensure = (ok: boolean, message: string): void => {
  if (!ok) throw new Error(message);
};

// Semantic checks from requireFrozenLiveManifest(). JSON Schema validation (Ajv)
// runs in the backend before the manifest is served; it isn't available in WASM.
export const checkFrozenManifest = (
  keccakUtf8: KeccakUtf8,
  manifest: Manifest,
  nowMs: number,
  frozenHash: string,
): void => {
  ensure(manifest.manifestHash === frozenHash, "manifest is not the frozen live authority");
  ensure(manifestCommitment(keccakUtf8, manifest) === frozenHash, "manifest commitment mismatch");
  ensure(manifest.policyHash === commitment(keccakUtf8, "perpparrot:policy:v1", manifest.policy), "policy commitment mismatch");
  ensure(manifest.status === "VALID" && manifest.mode === "LIVE" && manifest.reason === "OK", "manifest is not VALID/LIVE/OK");
  ensure(manifest.bucket === manifest.policy.bucket && manifest.mode === manifest.policy.mode, "nested policy mismatch");
  ensure(manifest.createdAtMs <= nowMs && nowMs < manifest.expiresAtMs, "expired/future manifest");
  ensure(manifest.sources.length > 0, "manifest has no sources");
  const addresses = new Set(manifest.sources.map((s) => s.sourceAddress));
  ensure(addresses.size === manifest.sources.length, "duplicate source");
  ensure(
    manifest.sources.every((s) => s.weight > 0 && s.weight <= s.maxAllocation && s.maxAllocation <= manifest.policy.maxSourceWeight),
    "allocation exceeds ceiling",
  );
  const sum = manifest.sources.reduce((total, s) => total + s.weight, 0);
  ensure(Math.abs(sum + manifest.cashWeight - 1) <= 1e-9, "invalid capital total");
  ensure(manifest.cashWeight >= manifest.policy.cashBuffer - 1e-9, "cash below buffer");
};

// Integer weights for bigint copy math (sum ≤ 1e6; the rest is cash).
export const manifestWeightsE6 = (manifest: Manifest): Map<string, number> =>
  new Map(manifest.sources.map((s) => [s.sourceAddress.toLowerCase(), Math.round(s.weight * 1_000_000)]));

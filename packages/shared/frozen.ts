// The frozen configuration: the mirror's only execution authority. Same shape and
// commitment as the review core's packages/shared/src/frozen.ts (branch
// ai-agent-workflow), which builds it from a VALID/LIVE review with proposeFreeze().
//
// That core expects a ConfirmedFreeze from a chain adapter. Here the trusted
// confirmation is the configurationHash pinned in both services' environment
// (FROZEN_CONFIGURATION_HASH, README §4.7), so no onchain contract is needed.
import { commitment, type KeccakUtf8 } from "./commitments";

export const WEIGHT_UNITS = 1_000_000;

export type FrozenSource = {
  candidate: number;
  sourceAddress: string;
  weightUnits: number;
  ceilingUnits: number;
};

export type FrozenPolicy = Record<string, unknown> & {
  bucket: string;
  mode: string;
  maxSourceWeight: number;
  maxGrossLeverage: number;
  cashBuffer: number;
};

export type FrozenConfiguration = {
  schemaVersion: "1.0.0";
  // Our HL account: the only account the mirror may size for.
  account: string;
  chainId: number;
  frozenAtMs: number;
  // manifestHash of the review the freeze came from.
  reviewHash: string;
  policy: FrozenPolicy;
  policyHash: string;
  sources: FrozenSource[];
  cashUnits: number;
  configurationHash: string;
};

const ADDRESS = /^0x[0-9a-f]{40}$/;
const HASH = /^0x[0-9a-f]{64}$/;

const ensure = (ok: boolean, message: string): void => {
  if (!ok) throw new Error(message);
};

const exactKeys = (value: object, keys: string[]) =>
  ensure(Object.keys(value).sort().join(",") === [...keys].sort().join(","), "unknown or missing configuration fields");

const unit = (n: unknown) => typeof n === "number" && Number.isFinite(n) && n >= 0 && n <= 1;

// validateFrozenConfiguration() + the pinned-hash confirmation. The review core
// also validates the policy against bucket-policy.schema.json (Ajv), which isn't
// available in WASM; the backend serves only configurations that passed it, and
// the commitment check below binds whatever it served to the pinned hash.
export const checkFrozenConfiguration = (
  keccakUtf8: KeccakUtf8,
  value: FrozenConfiguration,
  pinnedHash: string,
  nowMs: number,
): void => {
  ensure(value !== null && typeof value === "object", "invalid frozen configuration");
  ensure(value.configurationHash === pinnedHash, "configuration is not the pinned frozen authority");
  exactKeys(value, ["schemaVersion", "account", "chainId", "frozenAtMs", "reviewHash", "policy", "policyHash", "sources", "cashUnits", "configurationHash"]);
  ensure(value.schemaVersion === "1.0.0" && ADDRESS.test(value.account), "invalid frozen identity");
  ensure(Number.isSafeInteger(value.chainId) && value.chainId > 0 && Number.isSafeInteger(value.frozenAtMs) && value.frozenAtMs >= 0, "invalid frozen time/chain");
  ensure(nowMs >= value.frozenAtMs, "future frozen configuration");
  ensure(HASH.test(value.reviewHash) && HASH.test(value.configurationHash), "invalid frozen commitment");

  const { policy } = value;
  ensure(policy !== null && typeof policy === "object", "invalid frozen policy");
  ensure(policy.mode === "LIVE" && policy.bucket === "AGGRESSIVE", "unsupported live policy");
  ensure(unit(policy.maxSourceWeight) && unit(policy.cashBuffer), "invalid frozen policy");
  ensure(typeof policy.maxGrossLeverage === "number" && Number.isFinite(policy.maxGrossLeverage) && policy.maxGrossLeverage > 0, "invalid frozen policy");
  ensure(value.policyHash === commitment(keccakUtf8, "perpparrot:policy:v1", policy), "frozen policy mismatch");

  ensure(Array.isArray(value.sources) && value.sources.length >= 5 && value.sources.length <= 15, "freeze requires 5–15 sources");
  ensure(Number.isSafeInteger(value.cashUnits) && value.cashUnits >= Math.ceil(policy.cashBuffer * WEIGHT_UNITS), "invalid frozen cash buffer");
  let previousCandidate = -1;
  const addresses = new Set<string>();
  for (const source of value.sources) {
    exactKeys(source, ["candidate", "sourceAddress", "weightUnits", "ceilingUnits"]);
    ensure(
      Number.isSafeInteger(source.candidate) &&
        source.candidate > previousCandidate &&
        ADDRESS.test(source.sourceAddress) &&
        source.sourceAddress !== value.account &&
        !addresses.has(source.sourceAddress),
      "invalid frozen source identity/order",
    );
    ensure(
      Number.isSafeInteger(source.weightUnits) &&
        Number.isSafeInteger(source.ceilingUnits) &&
        source.weightUnits > 0 &&
        source.weightUnits <= source.ceilingUnits &&
        source.ceilingUnits <= Math.floor(policy.maxSourceWeight * WEIGHT_UNITS),
      "invalid frozen weight",
    );
    previousCandidate = source.candidate;
    addresses.add(source.sourceAddress);
  }
  ensure(value.cashUnits + value.sources.reduce((sum, s) => sum + s.weightUnits, 0) === WEIGHT_UNITS, "invalid frozen total");
  const { configurationHash, ...payload } = value;
  ensure(configurationHash === commitment(keccakUtf8, "perpparrot:frozen:v1", payload), "frozen commitment mismatch");
};

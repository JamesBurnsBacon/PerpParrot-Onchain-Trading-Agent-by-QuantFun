import { keccak256, stringToBytes } from "viem";
import { commitment } from "../../../shared/commitments";
import type { StrategyIntent } from "../../../shared/strategy-intent";

import type { Policy } from "../../../shared/src/contracts";
import { validateRuntimePolicy } from "../../../shared/src/policy-runtime";

export class PreviewError extends Error {
  constructor(readonly code: "too_few_sources" | "infeasible") {
    super(code);
    this.name = "PreviewError";
  }
}

export const buildPreview = ({ intent, basePolicy, addresses }: {
  intent: StrategyIntent; basePolicy: Policy; addresses: string[];
}) => {
  const n = addresses.length;
  if (n < 5 || n > 25) throw new PreviewError("too_few_sources");
  validateRuntimePolicy(basePolicy);
  // Visitor preferences are context only; saved policy comes exclusively from the base.
  const policy: Policy = { ...basePolicy, mode: "SIMULATION" };
  validateRuntimePolicy(policy);
  const cashUnits = Math.ceil(policy.cashBuffer * 1_000_000);
  const rest = 1_000_000 - cashUnits;
  const ceilingUnits = Math.floor(policy.maxSourceWeight * 1_000_000);
  const sources = addresses.map((address, i) => ({
    address, weightUnits: Math.floor(rest / n) + (i < rest % n ? 1 : 0), ceilingUnits,
  }));
  if (!Number.isSafeInteger(cashUnits) || cashUnits < 0 || cashUnits > 1_000_000 ||
      !Number.isSafeInteger(ceilingUnits) || ceilingUnits < 0 ||
      sources.some((source) => source.weightUnits > ceilingUnits) ||
      cashUnits + sources.reduce((sum, source) => sum + source.weightUnits, 0) !== 1_000_000) {
    throw new PreviewError("infeasible");
  }
  const version = "1" as const;
  const keccakUtf8 = (text: string) => keccak256(stringToBytes(text));
  // A separate domain from perpparrot:frozen:v1 prevents confusion with a pinned configuration hash.
  const previewHash = commitment(keccakUtf8, "perpparrot:parrot-preview:v1", { version, intent, policy, sources, cashUnits });
  return { approvalRequired: true as const, version, weighting: "equal (preview only)" as const, policy, sources, cashUnits, previewHash };
};

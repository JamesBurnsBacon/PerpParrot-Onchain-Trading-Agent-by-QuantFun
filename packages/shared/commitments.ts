// Commitments shared with the review core (branch ai-agent-workflow:
// packages/shared/src/commitments.ts). Must stay byte-identical:
// keccak256(UTF8(JCS({domain, payload}))).
//
// Dependency-free so the CRE workflow (WASM) can use it: callers pass keccak256
// over UTF-8 (viem's keccak256(stringToBytes(text)) in this repo).

export type KeccakUtf8 = (text: string) => string;

// RFC 8785-style canonical JSON, as in the review core's canonicalize().
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

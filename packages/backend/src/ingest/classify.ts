import { decodeFunctionResult, encodeFunctionData, parseAbi, type Hex } from "viem";
import { RpcError, type ReadClient } from "./client";
import { addressSchema, type Candidate, type KindResult } from "./types";

const abi = parseAbi([
  "function asset() view returns (address)",
  "function totalAssets() view returns (uint256)",
]);

export async function classify(candidate: Candidate, rpc: Pick<ReadClient, "rpc">, blockNumber: Hex): Promise<KindResult> {
  if (candidate.knownHypercoreVault) return { kind: "hypercore-vault", evidence: "vault-list" };
  const code = await rpc.rpc("eth_getCode", [candidate.address, blockNumber]);
  if (code === "0x" || code === "0x0") return { kind: "trader", evidence: "no-hyperevm-code", blockNumber };
  const values: Partial<Record<"asset" | "totalAssets", unknown>> = {};
  for (const functionName of ["asset", "totalAssets"] as const) {
    let result: Hex;
    try {
      result = await rpc.rpc("eth_call", [{ to: candidate.address, data: encodeFunctionData({ abi, functionName }) }, blockNumber]);
    } catch (error) {
      // A reverted probe means this heuristic did not match; transport failure is unknown.
      if (error instanceof RpcError && (error.code === 3 || /execution reverted/i.test(error.message))) {
        return { kind: "trader", evidence: "contract-probes-failed", blockNumber };
      }
      throw error;
    }
    try { values[functionName] = decodeFunctionResult({ abi, functionName, data: result }); }
    catch { return { kind: "trader", evidence: "contract-probes-failed", blockNumber }; }
  }
  return {
    kind: "erc4626-vault", evidence: "erc4626-probes", blockNumber,
    asset: addressSchema.parse(values.asset), totalAssets: String(values.totalAssets),
  };
}

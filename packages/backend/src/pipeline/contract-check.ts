// Which of the picks are contracts on HyperEVM? (CONTRACT_CHECK=on, needs NOWNODES_API_KEY; evidence only.)
//
// The leaderboard lists every account the same way, but an address that has code on HyperEVM is a contract
// (an ERC-4626 vault, a router, a protocol account) that trades on HyperCore through CoreWriter; it is not a
// person's wallet, and its history says little about a strategy we could copy. `eth_getCode` on NOWNodes'
// HyperEVM endpoint (hype.nownodes.io/evm) tells them apart, one read per address.
//
// Nothing here selects or excludes: the result is recorded with the run and shown on the dashboard. A read
// that fails is "unread", never "not a contract".
import { NOWNODES_URL } from "./info-router";

export const NOWNODES_EVM_URL = NOWNODES_URL.replace(/\/info$/, "/evm");

// Bytes of code at `address`, 0 for an account without code, null when the read failed or answered nonsense.
export type CodeReader = (address: string) => Promise<number | null>;

export type ContractCheck = {
  provider: "nownodes";
  checked: number;
  contracts: { address: string; bytes: number }[];
  unread: string[];
  ms: number;
};

export const nownodesCode = (key: string, fetchImpl: typeof fetch = fetch, timeoutMs = 15_000): CodeReader => async (address) => {
  try {
    const res = await fetchImpl(NOWNODES_EVM_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", "api-key": key },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_getCode", params: [address, "latest"] }),
      redirect: "error", // the key must never follow a redirect to another host
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { result?: unknown; error?: unknown };
    const code = body.result;
    // "0x" is no code; anything else must be hex of whole bytes. An RPC error or a malformed answer is unread.
    if (body.error || typeof code !== "string" || !/^0x(?:[0-9a-fA-F]{2})*$/.test(code)) return null;
    return (code.length - 2) / 2;
  } catch {
    return null;
  }
};

export const checkContracts = async (addresses: readonly string[], read: CodeReader, o: { concurrency?: number; now?: () => number } = {}): Promise<ContractCheck> => {
  const now = o.now ?? Date.now;
  const started = now();
  const unique = [...new Set(addresses.map((a) => a.toLowerCase()))];
  const results = new Map<string, number | null>();
  let next = 0;
  const worker = async () => {
    while (next < unique.length) {
      const address = unique[next++]!;
      results.set(address, await read(address).catch(() => null));
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(o.concurrency ?? 6, unique.length)) }, worker));
  return {
    provider: "nownodes",
    checked: unique.length,
    contracts: unique.flatMap((address) => ((results.get(address) ?? 0) > 0 ? [{ address, bytes: results.get(address)! }] : [])),
    unread: unique.filter((address) => results.get(address) === null),
    ms: now() - started,
  };
};

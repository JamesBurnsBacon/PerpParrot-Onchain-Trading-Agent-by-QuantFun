// Which of the picks are contracts on HyperEVM? (CONTRACT_CHECK=on, needs NOWNODES_API_KEY; evidence only.)
//
// The leaderboard lists every account the same way, but an address that has code on HyperEVM is a contract (a
// vault, a router, a protocol account, a smart wallet). A contract can have a HyperCore account at the same
// address. This only reports which picks have code; it says nothing about whether they trade. On 2026-10-07 the
// 7 such addresses checked held no perp positions at that check, so this is a watch, not a known problem
// (issue #84). `eth_getCode` on NOWNodes' HyperEVM endpoint (hype.nownodes.io/evm) tells them apart, one read
// per address.
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
    const body = (await res.json()) as Record<string, unknown> | null;
    // Only a well-formed JSON-RPC answer to our request counts: version, id and no error member. Anything
    // else is unread, never "no code".
    if (!body || typeof body !== "object" || body.jsonrpc !== "2.0" || body.id !== 1 || "error" in body) return null;
    const code = body.result;
    // "0x" is no code; anything else must be hex of whole bytes.
    if (typeof code !== "string" || !/^0x(?:[0-9a-fA-F]{2})*$/.test(code)) return null;
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
  const requested = Number.isInteger(o.concurrency) && o.concurrency! > 0 ? o.concurrency! : 6; // a bad value falls back to the default
  await Promise.all(Array.from({ length: Math.max(1, Math.min(requested, unique.length)) }, worker));
  return {
    provider: "nownodes",
    checked: unique.length,
    contracts: unique.flatMap((address) => ((results.get(address) ?? 0) > 0 ? [{ address, bytes: results.get(address)! }] : [])),
    unread: unique.filter((address) => (results.get(address) ?? null) === null), // an address with no result counts as unread
    ms: now() - started,
  };
};

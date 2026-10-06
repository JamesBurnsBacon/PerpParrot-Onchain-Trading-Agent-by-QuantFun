import { concatHex, hexToBytes, toHex, type PublicClient } from "viem";

// Trust anchor for DON signers: Capability Registry on Ethereum mainnet.
export const CAPABILITY_REGISTRY = "0x76c9cf548b4179F8901cda1f8623568b58215E62" as const;

export type DonSigners = { f: number; signers: Set<string> };

export type SignerSource = (donId: number) => Promise<DonSigners>;

// The registry couldn't be read (RPC down, rate limited): transient, not a bad report.
export class SignerLookupError extends Error {}

const NO_SIGNERS: DonSigners = { f: 0, signers: new Set() };
const NEGATIVE_TTL_MS = 10 * 60_000;
// Uncached lookups allowed per minute, so forged reports with made-up DON IDs
// can't turn into unbounded RPC traffic.
const LOOKUPS_PER_MINUTE = 10;

const readU32 = (bytes: Uint8Array, offset: number) =>
  new DataView(bytes.buffer, bytes.byteOffset + offset + 28, 4).getUint32(0, false);

const u256 = (n: number) => {
  const b = new Uint8Array(32);
  new DataView(b.buffer).setUint32(28, n, false);
  return toHex(b);
};

// getDON(uint32) + getNodesByP2PIds(bytes32[]), decoded by hand as in the CRE guide.
// Signer sets only change on DON reconfiguration, so they're cached per DON ID.
export const registrySigners = (client: PublicClient, now: () => number = Date.now): SignerSource => {
  const cache = new Map<number, DonSigners>();
  // DON IDs the registry doesn't know (getDON reverts), remembered for a while.
  const unknown = new Map<number, number>();
  let windowStart = 0;
  let lookups = 0;

  const call = async (data: `0x${string}`) => {
    try {
      return await client.call({ to: CAPABILITY_REGISTRY, data });
    } catch (e) {
      if (/revert/i.test((e as Error).message)) throw e;
      throw new SignerLookupError(`Capability Registry read failed: ${(e as Error).message.split("\n")[0]}`);
    }
  };

  return async (donId) => {
    const cached = cache.get(donId);
    if (cached) return cached;
    if ((unknown.get(donId) ?? 0) > now()) return NO_SIGNERS;

    if (now() - windowStart >= 60_000) {
      windowStart = now();
      lookups = 0;
    }
    if (++lookups > LOOKUPS_PER_MINUTE) throw new SignerLookupError("too many signer lookups; try again shortly");

    let don;
    try {
      don = await call(concatHex(["0x23537405", u256(donId)]));
    } catch (e) {
      if (e instanceof SignerLookupError) throw e;
      unknown.set(donId, now() + NEGATIVE_TTL_MS);
      return NO_SIGNERS;
    }
    if (!don.data) throw new Error("getDON returned empty response");
    const donBytes = hexToBytes(don.data);

    const f = readU32(donBytes, 96);
    const countOffset = 32 + readU32(donBytes, 192);
    const nodeCount = readU32(donBytes, countOffset);
    const p2pIds = Array.from({ length: nodeCount }, (_, i) => {
      const start = countOffset + 32 + i * 32;
      return toHex(donBytes.slice(start, start + 32));
    });

    const signers = new Set<string>();
    if (nodeCount > 0) {
      const nodes = await call(concatHex(["0x05a51966", u256(32), u256(nodeCount), ...p2pIds]));
      if (!nodes.data) throw new Error("getNodesByP2PIds returned empty response");
      const nodeBytes = hexToBytes(nodes.data);

      const outer = readU32(nodeBytes, 0);
      const returned = readU32(nodeBytes, outer);
      const NODE_TUPLE_HEAD = 288;
      for (let i = 0; i < returned; i++) {
        const base = outer + 32 + readU32(nodeBytes, outer + 32 + i * 32);
        if (base + NODE_TUPLE_HEAD > nodeBytes.length) break;
        signers.add(toHex(nodeBytes.slice(base + 96, base + 116)).toLowerCase());
      }
    }

    const result = { f, signers };
    cache.set(donId, result);
    return result;
  };
};

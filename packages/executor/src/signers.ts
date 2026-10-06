import { concatHex, hexToBytes, toHex, type PublicClient } from "viem";

// Trust anchor for DON signers: Capability Registry on Ethereum mainnet.
export const CAPABILITY_REGISTRY = "0x76c9cf548b4179F8901cda1f8623568b58215E62" as const;

export type DonSigners = { f: number; signers: Set<string> };

export type SignerSource = (donId: number) => Promise<DonSigners>;

const readU32 = (bytes: Uint8Array, offset: number) =>
  new DataView(bytes.buffer, bytes.byteOffset + offset + 28, 4).getUint32(0, false);

const u256 = (n: number) => {
  const b = new Uint8Array(32);
  new DataView(b.buffer).setUint32(28, n, false);
  return toHex(b);
};

// getDON(uint32) + getNodesByP2PIds(bytes32[]), decoded by hand as in the CRE guide.
// Signer sets only change on DON reconfiguration, so they're cached per DON ID.
export const registrySigners = (client: PublicClient): SignerSource => {
  const cache = new Map<number, DonSigners>();

  return async (donId) => {
    const cached = cache.get(donId);
    if (cached) return cached;

    const don = await client.call({ to: CAPABILITY_REGISTRY, data: concatHex(["0x23537405", u256(donId)]) });
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
      const nodes = await client.call({
        to: CAPABILITY_REGISTRY,
        data: concatHex(["0x05a51966", u256(32), u256(nodeCount), ...p2pIds]),
      });
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

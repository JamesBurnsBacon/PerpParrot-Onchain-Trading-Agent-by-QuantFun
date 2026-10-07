import { describe, expect, test } from "bun:test";
import { checkContracts, nownodesCode, NOWNODES_EVM_URL, type CodeReader } from "../src/pipeline/contract-check";

const rpc = (result: unknown, status = 200, extra: Record<string, unknown> = {}) => new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result, ...extra }), { status });

describe("nownodesCode", () => {
  test("posts eth_getCode to the /evm endpoint with the key in a header and no redirects", async () => {
    const seen: { url: string; key: string | null; redirect?: string; body: unknown }[] = [];
    const fake = (async (url: string, init?: RequestInit) => {
      seen.push({ url, key: new Headers(init?.headers).get("api-key"), redirect: init?.redirect, body: JSON.parse(String(init?.body)) });
      return rpc("0x6080");
    }) as unknown as typeof fetch;
    expect(await nownodesCode("secret", fake)("0xABC")).toBe(2);
    expect(NOWNODES_EVM_URL).toBe("https://hype.nownodes.io/evm");
    expect(seen[0]).toEqual({ url: NOWNODES_EVM_URL, key: "secret", redirect: "error", body: { jsonrpc: "2.0", id: 1, method: "eth_getCode", params: ["0xABC", "latest"] } });
  });

  test("an account without code is 0 bytes, not unread", async () => {
    expect(await nownodesCode("k", (async () => rpc("0x")) as unknown as typeof fetch)("0xabc")).toBe(0);
  });

  test("a failed or malformed answer is unread (null), never 'not a contract'", async () => {
    const answers: (() => Response | Promise<Response>)[] = [
      () => rpc(null, 500),
      () => rpc("0x", 200, { error: { code: -32000 } }),
      () => rpc(undefined),
      () => rpc("not hex"),
      () => rpc("0x123"), // odd number of hex digits
      () => new Response("<html>", { status: 200 }),
      () => Promise.reject(new Error("network")),
    ];
    for (const a of answers) expect(await nownodesCode("k", (async () => a()) as unknown as typeof fetch)("0xabc")).toBeNull();
  });
});

describe("checkContracts", () => {
  const codes: Record<string, number | null> = { "0xa": 0, "0xb": 793, "0xc": null, "0xd": 76 };
  const read: CodeReader = async (a) => (a in codes ? codes[a]! : 0);

  test("lists contracts and unread addresses separately, lowercased and de-duplicated", async () => {
    const out = await checkContracts(["0xA", "0xB", "0xb", "0xC", "0xD"], read);
    expect(out).toMatchObject({ provider: "nownodes", checked: 4 });
    expect(out.contracts).toEqual([{ address: "0xb", bytes: 793 }, { address: "0xd", bytes: 76 }]);
    expect(out.unread).toEqual(["0xc"]);
  });

  test("a reader that throws counts as unread", async () => {
    const out = await checkContracts(["0xa", "0xb"], async (a) => {
      if (a === "0xb") throw new Error("boom");
      return 0;
    });
    expect(out.unread).toEqual(["0xb"]);
    expect(out.contracts).toEqual([]);
  });

  test("never has more reads in flight than the concurrency limit", async () => {
    let inFlight = 0;
    let peak = 0;
    const slow: CodeReader = async () => {
      peak = Math.max(peak, ++inFlight);
      await new Promise((r) => setTimeout(r, 2));
      inFlight--;
      return 0;
    };
    await checkContracts(Array.from({ length: 20 }, (_, i) => `0x${i}`), slow, { concurrency: 3 });
    expect(peak).toBeLessThanOrEqual(3);
    expect(peak).toBeGreaterThan(1);
  });

  test("no addresses is an empty, valid result", async () => {
    expect(await checkContracts([], read)).toMatchObject({ checked: 0, contracts: [], unread: [] });
  });
});

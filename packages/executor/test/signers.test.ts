import { describe, expect, test } from "bun:test";
import type { PublicClient } from "viem";
import { handleReport } from "../src/handler";
import { registrySigners, SignerLookupError } from "../src/signers";
import { ACCOUNT, AS_OF, CONFIGURATION, envelope, keys, OWNER } from "./helpers";

// Stub client: getDON for DON 7 → f = 1 with no nodes; anything else reverts or fails.
const client = (behaviour: "revert" | "down" | "ok") => {
  let calls = 0;
  const c = {
    call: async ({ data }: { data: string }) => {
      calls++;
      if (behaviour === "down") throw new Error("fetch failed: ECONNREFUSED");
      if (behaviour === "revert" || !data.endsWith("7")) throw new Error("Execution reverted for an unknown reason.");
      // getDON struct: slot 3 = f, slot 6 = node array offset (read 32 bytes on, as in the CRE guide); empty array.
      const words = Array.from({ length: 9 }, () => "0".repeat(64));
      words[3] = "1".padStart(64, "0");
      words[6] = (32 * 7).toString(16).padStart(64, "0");
      return { data: `0x${words.join("")}` as `0x${string}` };
    },
  };
  return { client: c as unknown as PublicClient, calls: () => calls };
};

describe("registrySigners", () => {
  test("reads f and caches per DON", async () => {
    const c = client("ok");
    const signers = registrySigners(c.client);
    expect((await signers(7)).f).toBe(1);
    await signers(7);
    expect(c.calls()).toBe(1);
  });

  test("re-reads a DON's signers after an hour", async () => {
    let now = 0;
    const c = client("ok");
    const signers = registrySigners(c.client, () => now);
    await signers(7);
    now = 59 * 60_000;
    await signers(7);
    expect(c.calls()).toBe(1);
    now = 61 * 60_000;
    await signers(7);
    expect(c.calls()).toBe(2);
  });

  test("keeps the last good signer set when a refresh can't reach the registry", async () => {
    let now = 0;
    let down = false;
    const ok = client("ok");
    const flaky = { call: async (args: { data: string }) => (down ? client("down").client.call(args as never) : ok.client.call(args as never)) };
    const signers = registrySigners(flaky as unknown as PublicClient, () => now);
    expect((await signers(7)).f).toBe(1);
    down = true;
    now = 2 * 60 * 60_000;
    expect((await signers(7)).f).toBe(1);
    await expect(signers(8)).rejects.toBeInstanceOf(SignerLookupError); // nothing cached for DON 8
  });

  test("remembers unknown DON IDs instead of asking again", async () => {
    let now = 0;
    const c = client("revert");
    const signers = registrySigners(c.client, () => now);
    expect((await signers(99)).signers.size).toBe(0);
    await signers(99);
    expect(c.calls()).toBe(1);
    now = 11 * 60_000;
    await signers(99);
    expect(c.calls()).toBe(2);
  });

  test("treats an unreachable registry as transient", async () => {
    await expect(registrySigners(client("down").client)(7)).rejects.toBeInstanceOf(SignerLookupError);
  });

  test("caps uncached lookups per minute", async () => {
    const signers = registrySigners(client("revert").client, () => 0);
    for (let id = 100; id < 110; id++) await signers(id);
    await expect(signers(200)).rejects.toThrow("too many signer lookups");
  });
});

describe("handleReport with an unreachable registry", () => {
  test("answers 503, not 401", async () => {
    const r = await handleReport(await envelope(keys.slice(0, 2)), {
      mode: { kind: "registry", signers: registrySigners(client("down").client), workflowOwner: OWNER },
      frozenConfigurationHash: CONFIGURATION,
      account: ACCOUNT,
      now: () => AS_OF,
      maxLeadSeconds: 60,
      maxTtlSeconds: 300,
      claim: async () => true,
      accept: () => {},
    });
    expect(r.status).toBe(503);
  });
});

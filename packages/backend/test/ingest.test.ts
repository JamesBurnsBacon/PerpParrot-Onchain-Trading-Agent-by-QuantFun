import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { encodeFunctionResult, parseAbi } from "viem";
import { classify } from "../src/ingest/classify";
import { ReadClient, RpcError, SOURCES, type Fetcher } from "../src/ingest/client";
import { discover } from "../src/ingest/discovery";
import { ingest } from "../src/ingest/pipeline";
import { SnapshotStore } from "../src/ingest/store";
import { compareUsd, summarizePortfolio, type Candidate } from "../src/ingest/types";

const address = (n: number) => `0x${n.toString(16).padStart(40, "0")}` as `0x${string}`;
const row = (n: number, value: string) => ({ ethAddress: address(n), accountValue: value });
const vault = (n: number, tvl: string, isClosed = false) => ({ summary: {
  vaultAddress: address(n), tvl, isClosed, name: "example", leader: address(99),
} });
const history = () => ["month", "allTime"].map((name) => [name, {
  accountValueHistory: [[1000, "10000.01"], [3000, "10100.01"]],
  pnlHistory: [[1000, "-1.01"], [3000, "98.99"]], vlm: "20000",
}]);
const sample: Candidate = {
  address: address(1), accountValueOrTvlUsd: "10000", valueSource: "leaderboard-account-value",
  sources: ["leaderboard"], name: null, knownHypercoreVault: false, leaderAddress: null,
};
const tempPaths: string[] = [];
const temp = async () => { const p = await mkdtemp(join(tmpdir(), "perpparrot-ingest-test-")); tempPaths.push(p); return p; };
afterEach(async () => { await Promise.all(tempPaths.splice(0).map((p) => rm(p, { recursive: true, force: true }))); });

describe("universe discovery", () => {
  test("$10k threshold is exact even beyond floating point precision", () => {
    expect(compareUsd("9999.999999999999999999", "10000")).toBe(-1);
    expect(compareUsd("10000.000", "10000")).toBe(0);
    expect(compareUsd("-0.1", "0")).toBe(-1);
    const result = discover({ leaderboardRows: [row(1, "9999.999999999999999999"), row(2, "10000")] }, [], 200);
    expect(result.shortlist.map((c) => c.address)).toEqual([address(2)]);
  });
  test("unions sources, deduplicates case-insensitively, uses vault TVL and excludes closed vaults", () => {
    const result = discover({ leaderboardRows: [row(1, "20000"), row(2, "999999"), row(3, "40000")] }, [
      vault(1, "50000"), vault(2, "999999", true), vault(4, "30000"),
    ], 2);
    expect(result.stats.eligibleUniqueAddresses).toBe(3);
    expect(result.shortlist.map((c) => c.address)).toEqual([address(1), address(3)]);
    expect(result.shortlist[0].sources).toHaveLength(2);
    expect(result.shortlist[0].knownHypercoreVault).toBe(true);
    expect(result.candidates.some((c) => c.address === address(4))).toBe(true);
  });
  test("normalizes address case and breaks equal-value ties by address", () => {
    const upper = address(10).replace(/a$/, "A");
    const result = discover({ leaderboardRows: [row(11, "10000"), { ...row(10, "10000"), ethAddress: upper }] }, [vault(10, "10000")], 10);
    expect(result.candidates.map((c) => c.address)).toEqual([address(10), address(11)]);
    expect(result.candidates[0].knownHypercoreVault).toBe(true);
  });
  test("rejects changed or ambiguous upstream schema instead of silently dropping data", () => {
    expect(() => discover({ rows: [] }, [], 200)).toThrow();
    expect(() => discover({ leaderboardRows: [row(1, "10000"), row(1, "20000")] }, [], 200)).toThrow("Duplicate");
    expect(() => discover({ leaderboardRows: [] }, [vault(1, "10000"), vault(1, "20000")], 200)).toThrow("Duplicate");
  });
});

describe("kind labeling at a pinned block", () => {
  test("known vault needs no HyperEVM call", async () => {
    const result = await classify({ ...sample, knownHypercoreVault: true }, { rpc: async () => { throw new Error("must not call"); } }, "0x123");
    expect(result).toEqual({ kind: "hypercore-vault", evidence: "vault-list" });
  });
  test("EOA is trader and RPC is pinned to the recorded block", async () => {
    const result = await classify(sample, { rpc: async (method, params) => {
      expect(method).toBe("eth_getCode"); expect(params).toEqual([sample.address, "0x123"]); return "0x";
    } }, "0x123");
    expect(result.kind).toBe("trader");
  });
  test("ERC4626 classification requires BOTH successful ABI-decodable probes", async () => {
    const abi = parseAbi(["function asset() view returns (address)", "function totalAssets() view returns (uint256)"]);
    const responses = ["0x6000", encodeFunctionResult({ abi, functionName: "asset", result: address(5) }),
      encodeFunctionResult({ abi, functionName: "totalAssets", result: 900719925474099312345n })] as `0x${string}`[];
    let calls = 0;
    const result = await classify(sample, { rpc: async (_method, params) => { expect(params.at(-1)).toBe("0x123"); return responses[calls++]; } }, "0x123");
    expect(calls).toBe(3);
    expect(result).toMatchObject({ kind: "erc4626-vault", asset: address(5), totalAssets: "900719925474099312345" });
  });
  test("reverted contract probe follows the documented trader fallback", async () => {
    const result = await classify(sample, { rpc: async (method) => {
      if (method === "eth_getCode") return "0x6000";
      throw new RpcError(3, "execution reverted");
    } }, "0x123");
    expect(result.evidence).toBe("contract-probes-failed");
  });
  test("network/unknown RPC errors never turn into trader labels", async () => {
    await expect(classify(sample, { rpc: async () => { throw new Error("HTTP 503"); } }, "0x123")).rejects.toThrow("503");
  });
});

describe("raw portfolio evidence", () => {
  test("keeps irregular timestamps, negative PnL and short histories; does not apply score filters", () => {
    const result = summarizePortfolio(history());
    expect(result.month.pnlPoints).toBe(2);
    expect(result.month.firstPnlTimeMs).toBe(1000);
    expect(result.month.lastPnlTimeMs).toBe(3000);
  });
  test("missing windows, invalid decimals and reversed histories fail validation", () => {
    expect(() => summarizePortfolio([])).toThrow("missing");
    expect(() => summarizePortfolio([["month", { accountValueHistory: [], pnlHistory: [[2, "NaN"]], vlm: "0" }]])).toThrow();
    const rows = history() as [string, { accountValueHistory: [number, string][]; pnlHistory: [number, string][]; vlm: string }][];
    rows[0][1].pnlHistory.reverse();
    expect(() => summarizePortfolio(rows)).toThrow("Non-monotonic");
  });
  test("repeated timestamps fail even if their values are identical", () => {
    const rows = history() as [string, { accountValueHistory: [number, string][]; pnlHistory: [number, string][]; vlm: string }][];
    rows[0][1].accountValueHistory.push([...rows[0][1].accountValueHistory.at(-1)!]);
    expect(() => summarizePortfolio(rows)).toThrow("strictly increase");
  });
});

describe("cache and snapshot persistence", () => {
  test("TTL uses original fetch time; refreshes preserve prior raw responses", async () => {
    const store = new SnapshotStore(await temp());
    const now = Date.now();
    const first = await store.cache("leaderboard", '{"v":1}', SOURCES.leaderboard, new Date(now).toISOString());
    expect(await store.cached("leaderboard", SOURCES.leaderboard, 1000, now + 999)).not.toBeNull();
    expect(await store.cached("leaderboard", SOURCES.leaderboard, 1000, now + 1000)).toBeNull();
    await store.cache("leaderboard", '{"v":2}', SOURCES.leaderboard, new Date(now + 1000).toISOString());
    expect(await readFile(join(store.root, `blobs/${first.sha256}.json`), "utf8")).toBe('{"v":1}');
  });
  test("corrupted cache and partial JSON are rejected", async () => {
    const store = new SnapshotStore(await temp());
    const entry = await store.cache("vaults", "[]", SOURCES.vaults, new Date().toISOString());
    await writeFile(join(store.root, `blobs/${entry.sha256}.json`), "{}");
    await expect(store.cached("vaults", SOURCES.vaults, 3600000)).rejects.toThrow("integrity");
    await expect(store.cache("leaderboard", "{", SOURCES.leaderboard, new Date().toISOString())).rejects.toThrow();
  });
});

describe("HTTP bounds", () => {
  test("429 retries are bounded and successful responses are returned", async () => {
    let calls = 0;
    const client = new ReadClient({ spacingMs: 0, retries: 1, fetcher: (async () => ++calls === 1
      ? new Response("limited", { status: 429, headers: { "retry-after": "0.001" } }) : new Response("[]")) });
    expect(await client.request(SOURCES.info, { type: "portfolio", user: address(1) })).toBe("[]");
    expect(calls).toBe(2);
  });
  test("oversized responses and nonretryable errors fail", async () => {
    const client = new ReadClient({ spacingMs: 0, fetcher: async () => new Response("12345") });
    await expect(client.request(SOURCES.info, undefined, 1000, 4)).rejects.toThrow("oversized");
    const forbidden = new ReadClient({ spacingMs: 0, fetcher: async () => new Response("forbidden", { status: 403 }) });
    await expect(forbidden.request(SOURCES.info)).rejects.toThrow("403");
  });
});

test("end-to-end ingestion preserves successful runs when a later address request fails", async () => {
  const output = await temp();
  let portfolioFails = false;
  const requests: string[] = [];
  const fetcher: Fetcher = async (url, init) => {
    const source = String(url);
    requests.push(source);
    if (source === SOURCES.leaderboard) return Response.json({ leaderboardRows: [row(1, "20000")] });
    if (source === SOURCES.vaults) return Response.json([]);
    const body = JSON.parse(String(init?.body));
    if (source === SOURCES.info) {
      expect(body).toEqual({ type: "portfolio", user: address(1) });
      return portfolioFails ? new Response("down", { status: 503 }) : Response.json(history());
    }
    expect(["eth_getCode", "eth_blockNumber", "eth_chainId"]).toContain(body.method);
    return Response.json({ result: body.method === "eth_getCode" ? "0x" : "0x123" });
  };
  const dependencies = { downloads: new ReadClient({ spacingMs: 0, retries: 0, fetcher }),
    info: new ReadClient({ spacingMs: 0, retries: 0, fetcher }), rpc: new ReadClient({ spacingMs: 0, retries: 0, fetcher }) };
  const options = { output, limit: 1, cacheHours: 3, refresh: false };
  const first = await ingest(options, dependencies);
  expect(first.status).toBe("complete");
  expect(first.stats.successfulPortfolios).toBe(1);
  portfolioFails = true;
  const second = await ingest(options, dependencies);
  expect(second.status).toBe("partial");
  expect(second.sources.leaderboard?.cacheHit).toBe(true);
  expect(requests.filter((u) => u === SOURCES.leaderboard)).toHaveLength(1);
  const latest = JSON.parse(await readFile(join(output, "latest.json"), "utf8"));
  expect(latest.runId).toBe(first.runId);
  const firstRecord = JSON.parse(await readFile(join(output, first.files.records), "utf8"))[0];
  expect(JSON.parse(await readFile(join(output, firstRecord.portfolio.path), "utf8"))).toEqual(history());
  const failed = JSON.parse(await readFile(join(output, second.files.records), "utf8"))[0];
  expect(failed.portfolioError).toContain("503");
  expect(failed.classification.kind).toBe("trader");
});

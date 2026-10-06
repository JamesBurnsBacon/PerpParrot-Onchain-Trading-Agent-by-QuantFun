import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sample from "./fixtures/score/portfolio-sample.json";
import { sampleInputs } from "./score/helpers";
import { gzipRows } from "../src/ingest/loop/export-data";
import { activateFreshRegistry, importRelease } from "../src/ingest/loop/import-release";
import { refreshRegistry } from "../src/ingest/loop/refresh-registry";
import { LoopStore } from "../src/ingest/loop/store";
import { LoopService } from "../src/ingest/loop/service";
import { digest } from "../src/ingest/store";

const dirs: string[] = [], stores: LoopStore[] = [];
afterEach(async () => { for (const s of stores.splice(0)) s.close(); for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true }); });
function target() { const s = new LoopStore(":memory:"); stores.push(s); return s; }
async function release(count = 100, mismatch = false, future = false) {
  const dir = await mkdtemp(join(tmpdir(), "release-bootstrap-")); dirs.push(dir);
  const input = sampleInputs.find(i => i.address === "addr-21")!, raw = JSON.stringify(sample.find(i => i.id === "addr-21")!.portfolio);
  const now = Date.now(), fetchedAt = new Date(now + (future ? 60_000 : 0)).toISOString();
  const fillsRaw = JSON.stringify(Array.from({ length: 10 }, (_, oid) => ({ coin: "BTC", oid, sz: "1", time: input.month!.pnlHistory.at(-1)![0] })));
  const addresses = Array.from({ length: count }, (_, n) => `0x${(n + 1).toString(16).padStart(40, "0")}`);
  const files = [
    await gzipRows(dir, "discovery.jsonl.gz", addresses.map(address => ({ address, accountValueOrTvlUsd: String(input.accountValue),
      valueSource: "leaderboard-account-value", sources: ["leaderboard"], name: null, knownHypercoreVault: false, leaderAddress: null }))),
    await gzipRows(dir, "score-inputs.jsonl.gz", addresses.map(address => ({ ...input, address, tradeCount: mismatch ? 999 : 10 }))),
    await gzipRows(dir, "score-evidence.jsonl.gz", addresses.map(address => ({ schema: "score-evidence.v1", address,
      portfolio: { raw, sha256: digest(raw), fetchedAt }, fills: { raw: fillsRaw, sha256: digest(fillsRaw), fetchedAt },
      classification: { kind: "trader", evidence: "no-hyperevm-code" }, classificationAt: fetchedAt }))),
    // Unneeded large research assets need not be downloaded for this entry point.
    { file: "portfolios.jsonl.gz", format: "jsonl+gzip", rows: count, sha256: "0".repeat(64), bytes: 1 },
  ];
  await writeFile(join(dir, "manifest.json"), JSON.stringify({ schema: "score-data-release.v1", status: "complete",
    counts: { scoreInputs: count, excludedBeforeEvidence: 0 }, exportedAt: fetchedAt, files,
    codeCommit: "old-release-commit", scoreSourceSha256: "f".repeat(64) }));
  return { dir, now, addresses };
}

test("portable release alone creates a hash-verified current-Score registry without a source SQLite file", async () => {
  const { dir, now } = await release(), store = target(), result = await importRelease(dir, store, now);
  expect(result.imported).toBe(100); expect(result.ready).toBe(true); expect(result.selected).toBe(100);
  expect(result.selectionScope).toBe("complete-imported-registry");
  expect(result.scoreSourceSha256).not.toBe("f".repeat(64));
  expect(store.state<{ releaseCodeCommit: string }>("seed")!.releaseCodeCommit).toBe("old-release-commit");
  expect(store.accounts().every(a => Date.parse(a.fetchedAt) === now)).toBe(true);
  expect(store.runs()).toEqual([]); expect(store.state("latest")).toBeNull();
  await expect(importRelease(dir, store, now)).rejects.toThrow("empty");
});

test("portable bootstrap rejects corrupted download bytes and disagreement with raw trade evidence", async () => {
  const { dir, now } = await release(), store = target(), path = join(dir, "score-evidence.jsonl.gz");
  const bytes = await readFile(path); bytes[bytes.length - 1] ^= 1; await writeFile(path, bytes);
  await expect(importRelease(dir, store, now)).rejects.toThrow("integrity"); expect(store.accounts()).toHaveLength(0);
  const bad = await release(100, true), second = target();
  await expect(importRelease(bad.dir, second, bad.now)).rejects.toThrow("disagrees");
  expect(second.accounts()).toHaveLength(0); expect(second.state("bootstrapComplete")).toBeNull();
});

test("expired releases stay unready; bounded official-collector refresh resumes and selects only the fresh subset", async () => {
  const { dir, now } = await release(110), store = target(), later = now + 86_400_001;
  const imported = await importRelease(dir, store, later);
  expect(imported.ready).toBe(false); expect(imported.freshAccounts).toBe(0);
  expect(store.accounts().every(a => Date.parse(a.fetchedAt) === now)).toBe(true);
  const never = { async collect(): Promise<never> { throw new Error("not reached"); } };
  expect(() => new LoopService(store, never, undefined, () => later).trigger()).toThrow("bootstrap");
  let attempts = 0;
  await expect(refreshRegistry(store, { async collect(account) {
    if (++attempts === 11) throw new Error("network interrupted");
    return { account: { ...account, fetchedAt: new Date(later).toISOString() }, historyWarnings: [] };
  } }, 100, () => later)).rejects.toThrow("interrupted");
  expect(store.accounts().filter(a => Date.parse(a.fetchedAt) === later)).toHaveLength(10);
  expect(store.state("bootstrapComplete")).toBeNull();
  const resumed = await refreshRegistry(store, { async collect(account) {
    return { account: { ...account, fetchedAt: new Date(later).toISOString() }, historyWarnings: [] };
  } }, 90, () => later);
  expect(resumed.refreshed).toBe(90); expect(resumed.ready).toBe(true); expect(resumed.freshAccounts).toBe(100);
  expect(resumed.totalAccounts).toBe(110); expect(resumed.selectionScope).toBe("fresh-subset-of-imported-registry");
  expect(store.state<{ selected: { fetchedAt: string }[] }>("selection")!.selected.every(a => Date.parse(a.fetchedAt) === later)).toBe(true);
});

test("future-dated release evidence cannot create a ready registry", async () => {
  const { dir, now } = await release(100, false, true), store = target();
  await expect(importRelease(dir, store, now)).rejects.toThrow("Future-dated");
  expect(store.accounts()).toHaveLength(0); expect(store.state("bootstrapComplete")).toBeNull();
});

test("expiry clears formerly ready selection instead of retaining collection authority", async () => {
  const { dir, now } = await release(), store = target();
  expect((await importRelease(dir, store, now)).ready).toBe(true);
  const later = now + 86_400_001;
  expect((await activateFreshRegistry(store, later)).ready).toBe(false);
  expect(store.state("selection")).toBeNull(); expect(store.state("bootstrapComplete")).toBeNull();
  const service = new LoopService(store, { async collect(): Promise<never> { throw new Error("not reached"); } }, undefined, () => later);
  expect(() => service.trigger()).toThrow("bootstrap");
});

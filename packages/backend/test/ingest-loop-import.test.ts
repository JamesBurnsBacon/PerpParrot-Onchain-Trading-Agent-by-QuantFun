import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sample from "./fixtures/score/portfolio-sample.json";
import { sampleInputs } from "./score/helpers";
import { LoopStore, type Account } from "../src/ingest/loop/store";
import { importRegistry } from "../src/ingest/loop/import-registry";
import { priority } from "../src/ingest/loop/rank";

const directories: string[] = [], stores: LoopStore[] = [];
afterEach(async () => {
  for (const store of stores.splice(0)) store.close();
  for (const path of directories.splice(0)) await rm(path, { recursive: true, force: true });
});

async function setup() {
  const dir = await mkdtemp(join(tmpdir(), "ingest-import-")); directories.push(dir);
  const path = join(dir, "source.sqlite"), source = new LoopStore(path), now = Date.now();
  const input = sampleInputs.find(i => i.address === "addr-21")!;
  const raw = JSON.stringify(sample.find(i => i.id === "addr-21")!.portfolio);
  const rawHash = source.blob(raw);
  const fillsHash = source.blob(JSON.stringify(Array.from({ length: 10 }, (_, oid) => ({
    time: input.month!.pnlHistory.at(-1)![0], coin: "BTC", oid, sz: "1",
  }))));
  const accounts: Account[] = Array.from({ length: 100 }, (_, index) => {
    const address = `0x${(index + 1).toString(16).padStart(40, "0")}` as const;
    return { candidate: { address, accountValueOrTvlUsd: String(input.accountValue), valueSource: "leaderboard-account-value",
      sources: ["leaderboard"], name: null, knownHypercoreVault: false, leaderAddress: null },
      input: { ...structuredClone(input), address, tradeCount: 10 },
      rawHash, fillsHash, fetchedAt: new Date(now).toISOString(), classificationAt: new Date(now).toISOString(),
      fillsCheckedAt: new Date(now).toISOString(), classification: { kind: "trader", evidence: "no-hyperevm-code" }, basis: "verified-input" };
  });
  source.seed(accounts, { test: true }); source.setState("bootstrapComplete", { at: now });
  const selected = priority(accounts, now);
  source.setState("selection", { selected: [...selected].reverse() });
  source.setState("latest", { runId: "old-publication" }); source.claim(now);
  return { source, path, accounts, selected, now, rawHash, fillsHash };
}

test("read-only registry migration verifies evidence, re-ranks current Score, and never imports worker authority", async () => {
  const { source, path, selected, now, rawHash, fillsHash } = await setup(); source.close();
  const original = await readFile(path), target = new LoopStore(":memory:"); stores.push(target);
  const result = await importRegistry(path, target, now);
  expect(result.count).toBe(100); expect(result.verified).toBe(100); expect(result.selected).toBe(100);
  expect(target.state<{ selected: unknown[] }>("selection")!.selected).toEqual(selected);
  expect(target.state("bootstrapComplete")).not.toBeNull();
  expect(target.state("latest")).toBeNull(); expect(target.runs()).toEqual([]);
  expect(target.claim(now)).toBeString();
  expect(target.raw(rawHash)).toBeString(); expect(target.raw(fillsHash)).toBeString();
  expect(await readFile(path)).toEqual(original);
  await expect(importRegistry(path, target, now)).rejects.toThrow("empty");
});

test("registry migration refuses raw-evidence mismatch and rolls back imported accounts", async () => {
  const { source, path, accounts, now } = await setup();
  source.putAccount({ ...accounts[0], input: { ...accounts[0].input, tradeCount: 999 } }); source.close();
  const target = new LoopStore(":memory:"); stores.push(target);
  await expect(importRegistry(path, target, now)).rejects.toThrow("disagrees");
  expect(target.accounts()).toHaveLength(0); expect(target.state("bootstrapComplete")).toBeNull();
});

test("an imported stale registry remains unready and cannot launch a job", async () => {
  const { source, path, now } = await setup(); source.close();
  const target = new LoopStore(":memory:"); stores.push(target);
  await expect(importRegistry(path, target, now + 86_400_001)).rejects.toThrow("100 fresh");
  expect(target.state("bootstrapComplete")).toBeNull(); expect(target.state("selection")).toBeNull();
});

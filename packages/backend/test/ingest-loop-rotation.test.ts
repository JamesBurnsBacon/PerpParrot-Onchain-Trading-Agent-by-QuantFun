import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sampleInputs } from "./score/helpers";
import { LoopStore, bucketAt, INTERVAL_MS, type Account, type Selection, type Run } from "../src/ingest/loop/store";
import { LoopService } from "../src/ingest/loop/service";
import { availableAccounts, backgroundRefresh, BACKGROUND_POLICY } from "../src/ingest/loop/background";
import { priority } from "../src/ingest/loop/rank";
import { BudgetClient } from "../src/ingest/loop/client";
import { SOURCES } from "../src/ingest/client";
import type { Latest } from "../src/ingest/loop/http";

const stores = new Set<LoopStore>(), dirs: string[] = [];
afterEach(() => { for (const s of stores) s.close(); stores.clear(); for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
const time = bucketAt(Date.now()) + 180_000;
function open(path = ":memory:") { const s = new LoopStore(path); stores.add(s); return s; }
function close(s: LoopStore) { s.close(); stores.delete(s); }
function dbPath() { const p = mkdtempSync(join(tmpdir(), "ingest-rotation-")); dirs.push(p); return join(p, "state.sqlite"); }
function setup(count = 102, path = ":memory:") {
  const store = open(path), input = sampleInputs.find(i => i.address === "addr-21")!;
  const rawHash = store.blob("[]");
  const accounts: Account[] = Array.from({ length: count }, (_, n) => {
    const address = `0x${(n + 1).toString(16).padStart(40, "0")}` as const;
    return { candidate: { address, accountValueOrTvlUsd: "100000", valueSource: "leaderboard-account-value",
      sources: ["leaderboard"], name: null, knownHypercoreVault: false, leaderAddress: null },
      input: { ...structuredClone(input), address, tradeCount: 10, closed: false }, rawHash,
      fetchedAt: new Date(time).toISOString(), classification: { kind: "trader", evidence: "no-hyperevm-code" },
      classificationAt: new Date(time).toISOString(), fillsHash: null, fillsCheckedAt: null, basis: "verified-input" };
  });
  store.seed(accounts, { fixture: true });
  const selected = priority(accounts, time); store.setState("selection", { selected }); store.setState("bootstrapComplete", { at: time });
  return { store, accounts, selected };
}
const result = (account: Account, now: number) => ({ account: { ...account, fetchedAt: new Date(now).toISOString() }, historyWarnings: [] });

test("a candidate older than 24 hours returns through background refresh and rejoins unchanged strict ranking", async () => {
  const { store, accounts } = setup(101), now = time + 25 * 3_600_000;
  for (const account of accounts.slice(1)) store.putAccount(result(account, now).account);
  store.setState("selection", { selected: priority(store.accounts(), now) });
  expect(priority(store.accounts(), now).some(s => s.address === accounts[0].input.address)).toBe(false);
  const visited: string[] = [];
  const refresh = await backgroundRefresh(store, { async collect(account) { visited.push(account.input.address); return result(account, now); } }, () => now);
  expect(refresh).toMatchObject({ refreshed: 1, failures: 0 }); expect(visited).toEqual([accounts[0].input.address]);
  expect(store.state<{ selected: Selection[] }>("selection")!.selected[0].address).toBe(accounts[0].input.address);
  expect(store.health(accounts[0].input.address).lastSuccessAt).toBe(now);
});

test("bounded oldest-first rotation persists visits across restart and does not repeatedly choose a broken account", async () => {
  const path = dbPath(), { store, accounts } = setup(106, path), old = time - 25 * 3_600_000;
  for (const account of accounts.slice(100)) store.putAccount({ ...account, fetchedAt: new Date(old).toISOString() });
  const visited: string[] = [], policy = { ...BACKGROUND_POLICY, maxAccounts: 2 };
  await backgroundRefresh(store, { async collect(account) { visited.push(account.input.address); throw new Error("persistent account failure"); } }, () => time, undefined, policy);
  expect(visited).toEqual(accounts.slice(100, 102).map(a => a.input.address)); close(store);
  const restarted = open(path);
  await backgroundRefresh(restarted, { async collect(account) { visited.push(account.input.address); return result(account, time); } }, () => time, undefined, policy);
  expect(visited).toEqual(accounts.slice(100, 104).map(a => a.input.address));
  expect(restarted.state<{ attempted: number }>("backgroundTotals")!.attempted).toBe(4);
  expect(restarted.health(accounts[100].input.address).totalFailures).toBe(1);
});

test("one persistently failing account is quarantined and replaced by the next fresh strict candidate with explicit evidence", async () => {
  const { store, accounts, selected } = setup(), bad = accounts[0].input.address;
  const owner = store.claim(time)!; store.accountAttempt(bad, owner, time, { error: "earlier failure" }); store.release(owner);
  const service = new LoopService(store, { async collect(account) {
    if (account.input.address === bad) throw new Error("HTTP 404 on this account"); return result(account, time);
  } }, undefined, () => time);
  const run = service.trigger(); await service.execute(run);
  const publication = store.state<Latest>("latest")!, artifact = JSON.parse(store.raw(publication.artifactHash));
  expect(artifact.originalSelection).toEqual(selected); expect(artifact.effectiveSelection).toHaveLength(100);
  expect(artifact.selected).toEqual(artifact.effectiveSelection); expect(artifact.substitutions).toHaveLength(1);
  expect(artifact.substitutions[0]).toMatchObject({ slot: 0, from: bad, to: accounts[100].input.address, reason: "Error: HTTP 404 on this account" });
  expect(artifact.substitutions[0].rankingSha256).toMatch(/^[a-f0-9]{64}$/);
  expect(artifact.inputs.some((a: Account["input"]) => a.address === bad)).toBe(false);
  expect(new Set(artifact.inputs.map((a: Account["input"]) => a.address)).size).toBe(100);
  expect(artifact.strict.candidates.every((a: { eligible: boolean }) => a.eligible)).toBe(true);
  expect(store.health(bad)).toMatchObject({ consecutiveFailures: 2, totalFailures: 2, quarantinedUntil: time + 1_800_000 });
  expect(artifact.nextSelection.some((a: Selection) => a.address === bad)).toBe(false);
});

test("restart after substitution is committed resumes the effective slot and never silently changes the original selection", async () => {
  const path = dbPath(), { store, accounts } = setup(102, path), bad = accounts[10].input.address;
  let blocked!: () => void; const waiting = new Promise<void>(resolve => { blocked = resolve; });
  const first = new LoopService(store, { async collect(account, signal) {
    if (account.input.address === bad) throw new Error("account unavailable");
    if (account.input.address === accounts[100].input.address) {
      blocked(); await new Promise((_, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
    }
    return result(account, time);
  } }, undefined, () => time);
  const original = first.trigger(), attempt = first.start(original).catch(() => {}); await waiting; await first.stop(); await attempt;
  expect(store.records(original.id).size).toBe(10);
  expect(store.run(original.id)!.substitutions).toHaveLength(1); close(store);
  const restarted = open(path), visited: string[] = [];
  const second = new LoopService(restarted, { async collect(account) { visited.push(account.input.address); return result(account, time); } }, undefined, () => time);
  await second.execute(restarted.run(original.id)!);
  expect(visited).toHaveLength(90); expect(visited).not.toContain(bad);
  const completed = restarted.run(original.id)!;
  expect(completed.selected).toEqual(original.selected); expect(completed.substitutions).toHaveLength(1);
  expect(completed.effectiveSelection![10].address).toBe(accounts[100].input.address);
});

test("when no strict fresh replacement exists, a partial run cannot replace the previous complete publication", async () => {
  const { store, accounts } = setup(101); accounts[100].input.tradeCount = null; store.putAccount(accounts[100]); let now = time;
  const good = new LoopService(store, { async collect(account) { return result(account, now); } }, undefined, () => now);
  await good.execute(good.trigger()); const previous = store.state<Latest>("latest"); now += INTERVAL_MS;
  const broken = new LoopService(store, { async collect(account) { if (account.input.address === accounts[0].input.address) throw new Error("unavailable"); return result(account, now); } }, undefined, () => now);
  await expect(broken.execute(broken.trigger())).rejects.toThrow("unavailable");
  expect(store.state<Latest>("latest")).toEqual(previous);
});

test("foreground preempts idle refresh, waits for its lease release, and completes before any more background requests", async () => {
  const { store, accounts } = setup(101); let now = time, idle = false, release!: () => void;
  store.putAccount({ ...accounts[100], fetchedAt: new Date(time - 25 * 3_600_000).toISOString() });
  const waiting = new Promise<void>(resolve => { release = resolve; });
  let backgroundAborted = false, foregroundCalls = 0;
  const service = new LoopService(store, { async collect(account, signal) {
    if (idle && account.input.address === accounts[100].input.address) {
      release(); await new Promise((_, reject) => signal.addEventListener("abort", () => { backgroundAborted = true; reject(signal.reason); }, { once: true }));
    }
    foregroundCalls++; return result(account, now);
  } }, undefined, () => now);
  await service.start(service.trigger()); idle = true; const background = service.tick(); await waiting;
  now += INTERVAL_MS; await service.tick(); await background;
  expect(backgroundAborted).toBe(true); expect(foregroundCalls).toBe(200);
  expect(store.state<Latest>("latest")!.bucket).toBe(bucketAt(now));
  expect(store.health(accounts[100].input.address).totalFailures).toBe(0);
});

test("background and foreground share persisted quota reservations and one owner across SQLite connections", async () => {
  const path = dbPath(), { store, accounts } = setup(101, path), second = open(path); let now = time, slept = 0;
  store.putAccount({ ...accounts[100], fetchedAt: new Date(time - 25 * 3_600_000).toISOString() });
  store.reserve("info", 790, 800, now);
  const client = new BudgetClient(second, async () => Response.json([]), () => now, async ms => { slept += ms; now += ms; });
  await backgroundRefresh(second, { client, async collect(account, signal) {
    expect(store.claim(now)).toBeNull();
    await client.request(SOURCES.info, { type: "portfolio", user: account.input.address }, signal);
    return result(account, now);
  } }, () => now);
  expect(slept).toBeGreaterThanOrEqual(60_000); expect(client.requests).toBe(1);
  expect(store.reserve("info", 790, 800, now).wait).toBeGreaterThan(0);
  expect(store.claim(now)).toBeString();
});

test("last minute of each bucket is reserved for foreground: no background request starts", async () => {
  const { store } = setup(101); let calls = 0;
  const status = await backgroundRefresh(store, { async collect(account) { calls++; return result(account, time); } }, () => bucketAt(time) + 550_000);
  expect(status.status).toBe("foreground-reserved"); expect(calls).toBe(0);
});

test("replacement ranking never promotes missing trade evidence or an expired portfolio to fill the batch", async () => {
  const { store, accounts } = setup(103);
  store.putAccount({ ...accounts[100], input: { ...accounts[100].input, tradeCount: null } });
  store.putAccount({ ...accounts[101], fetchedAt: new Date(time - 86_400_001).toISOString() });
  const service = new LoopService(store, { async collect(account) {
    if (account.input.address === accounts[0].input.address) return { account: { ...result(account, time).account, input: { ...account.input, tradeCount: null } }, historyWarnings: [] };
    return result(account, time);
  } }, undefined, () => time);
  const run = service.trigger(); await service.execute(run);
  expect(store.run(run.id)!.substitutions![0].to).toBe(accounts[102].input.address);
  expect(store.run(run.id)!.substitutions![0].reason).toContain("strict Score eligibility");
});

test("quarantine cooldown alone cannot restore an old cache: a successful probe is required", async () => {
  const { store, accounts } = setup(101), bad = accounts[0].input.address;
  const owner = store.claim(time)!;
  store.accountAttempt(bad, owner, time, { error: "first failure" }); store.accountAttempt(bad, owner, time, { error: "second failure" }); store.release(owner);
  const later = time + 3_660_000;
  expect(availableAccounts(store, store.accounts(), later).some(a => a.input.address === bad)).toBe(false);
  store.setState("selection", { selected: priority(accounts.slice(1), later) });
  await backgroundRefresh(store, { async collect(account) { return result(account, later); } }, () => later);
  expect(store.health(bad)).toMatchObject({ consecutiveFailures: 0, totalFailures: 2, quarantinedUntil: 0 });
  expect(availableAccounts(store, store.accounts(), later).some(a => a.input.address === bad)).toBe(true);
});

test("publication rejects a changed effective selection without a valid substitution chain", () => {
  const { store, accounts, selected } = setup(101), owner = store.claim(time)!;
  const run = store.enqueue(bucketAt(time), selected, time);
  const effective = [...selected]; effective[0] = { ...effective[0], address: accounts[100].input.address };
  const inputs = [accounts[100], ...accounts.slice(1, 100)];
  expect(() => store.publish({ ...run, effectiveSelection: effective }, inputs, {}, selected, owner, time)).toThrow("substitution audit");
  expect(store.state("latest")).toBeNull(); store.release(owner);
});

test("pending failed foreground work cannot starve multi-slice stale-registry recovery, including restart", async () => {
  const path = dbPath(), { store, accounts } = setup(101, path), bad = accounts[0].input.address;
  for (const account of accounts) store.putAccount({ ...account, fetchedAt: new Date(time - 25 * 3_600_000).toISOString() });
  let now = time; const visited: string[] = [];
  const collector = { async collect(account: Account) {
    visited.push(account.input.address); if (account.input.address === bad) throw new Error("persistent failure");
    return result(account, now);
  } };
  const first = new LoopService(store, collector, undefined, () => now), original = first.trigger();
  await expect(first.start(original)).rejects.toThrow("persistent failure");
  expect(store.state("foregroundNeedsRefresh")).not.toBeNull(); expect(store.state("bootstrapComplete")).toBeNull();
  close(store); now += 60_000;
  const restarted = open(path), second = new LoopService(restarted, collector, undefined, () => now);
  for (let i = 0; i < 5; i++) {
    const progress = await second.tick() as { refreshed: number };
    expect(progress.refreshed).toBe(20); expect(restarted.run(original.id)!.attempts).toBe(1);
  }
  expect(visited.filter(a=>a===bad)).toHaveLength(1);
  expect(restarted.state("foregroundNeedsRefresh")).toBeNull();
  expect(restarted.state<{ selected: Selection[] }>("selection")!.selected).toHaveLength(100);
  await second.tick(); const completed = restarted.run(original.id)!;
  expect(completed.status).toBe("complete"); expect(completed.substitutions).toHaveLength(1);
  expect(completed.substitutions![0].from).toBe(bad); expect(completed.selected).toEqual(original.selected);
});

test("an interrupted slice persists pending ranking and the next slice ranks before new API work", async () => {
  const path = dbPath(), { store, accounts } = setup(103, path);
  for (const account of accounts.slice(100)) store.putAccount({ ...account, fetchedAt: new Date(time - 25 * 3_600_000).toISOString() });
  store.setState("bootstrapComplete", null); store.setState("selection", null);
  const abort = new AbortController(); let calls = 0;
  await backgroundRefresh(store, { async collect(account) {
    if (++calls === 2) { abort.abort(new Error("slice interrupted")); throw abort.signal.reason; }
    return result(account, time);
  } }, () => time, abort.signal);
  expect(store.state("backgroundRankingPending")).not.toBeNull(); expect(store.state("bootstrapComplete")).toBeNull();
  close(store); const restarted = open(path); let extraCalls = 0;
  const resumed = await backgroundRefresh(restarted, { async collect(account) { extraCalls++; return result(account, time); } }, () => time);
  expect(resumed.refreshed).toBe(0); expect(extraCalls).toBe(0);
  expect(restarted.state("backgroundRankingPending")).toBeNull(); expect(restarted.state("bootstrapComplete")).not.toBeNull();
  expect(restarted.state<{ selected: Selection[] }>("selection")!.selected).toHaveLength(100);
});

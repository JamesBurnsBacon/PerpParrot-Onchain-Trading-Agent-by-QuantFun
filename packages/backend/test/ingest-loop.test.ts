import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sampleInputs } from "./score/helpers";
import { scoreCandidates } from "../src/score";
import { LoopStore, bucketAt, runIdAt, type Account, type Selection } from "../src/ingest/loop/store";
import { LoopService } from "../src/ingest/loop/service";
import { loopHandler, type Latest } from "../src/ingest/loop/http";
import { priority } from "../src/ingest/loop/rank";
import { BudgetClient } from "../src/ingest/loop/client";
import { SOURCES } from "../src/ingest/client";

const stores: LoopStore[] = [], dirs: string[] = [];
afterEach(() => { for (const s of stores.splice(0)) s.close(); for (const p of dirs.splice(0)) rmSync(p, { recursive: true, force: true }); });
const input = sampleInputs.find(i => i.address === "addr-21")!;
const start = bucketAt(Date.now());
function setup(count = 100, path = ":memory:") {
  const store = new LoopStore(path); stores.push(store);
  const rawHash = store.blob("[]");
  const accounts: Account[] = Array.from({ length: count }, (_, n) => {
    const address = `0x${(n + 1).toString(16).padStart(40, "0")}` as `0x${string}`;
    return { candidate: { address, accountValueOrTvlUsd: "100000", valueSource: "leaderboard-account-value", sources: ["leaderboard"], name: null, knownHypercoreVault: false, leaderAddress: null },
      input: { ...structuredClone(input), address, tradeCount: 10, closed: false }, fetchedAt: new Date(start).toISOString(), rawHash,
      classification: { kind: "trader", evidence: "no-hyperevm-code", blockNumber: "0x1" }, classificationAt: new Date(start).toISOString(),
      fillsHash: null, fillsCheckedAt: null, basis: "verified-input" };
  });
  store.seed(accounts, { count });
  const selected: Selection[] = accounts.slice(0, 100).map((a, i) => ({ address: a.input.address, score: 0.5, pool: "trader", rank: i + 1, fetchedAt: a.fetchedAt, basis: a.basis }));
  store.setState("selection", { selected }); store.setState("bootstrapComplete", { at: start });
  return { store, accounts, selected };
}

describe("durable Top 100 cycle", () => {
  test("failure at account 11 never publishes; a new service resumes the ten durable records", async () => {
    const { store, selected } = setup(); let calls = 0;
    const first = new LoopService(store, { async collect(account) { if (++calls === 11) throw new Error("HTTP 503"); return { account, historyWarnings: [] }; } }, async () => selected, () => start);
    const run = first.trigger();
    await expect(first.execute(run)).rejects.toThrow("503");
    expect(store.state("latest")).toBeNull(); expect(store.records(run.id).size).toBe(10);
    let resumed = 0;
    const second = new LoopService(store, { async collect(account) { resumed++; return { account, historyWarnings: [] }; } }, async () => selected, () => start);
    await second.execute(store.run(run.id)!);
    expect(resumed).toBe(90);
    const latest = store.state<Latest>("latest")!;
    expect(latest.count).toBe(100); expect(store.run(run.id)!.status).toBe("complete");
    await second.execute(store.run(run.id)!); expect(resumed).toBe(90);
    const artifact = JSON.parse(store.raw(latest.artifactHash));
    expect(artifact.inputs).toHaveLength(100); expect(artifact.strict.config.allowUnknown).toEqual([]);
    expect(artifact.nextSelection).toHaveLength(100);
  });
  test("second failed cycle retains the first complete artifact and next selection", async () => {
    const { store, selected } = setup(); let now = start;
    const first = new LoopService(store, { async collect(account) { return { account, historyWarnings: [] }; } }, async () => selected, () => now);
    await first.execute(first.trigger()); const latest = store.state<Latest>("latest");
    now += 600_000;
    const second = new LoopService(store, { async collect() { throw new Error("network down"); } }, async () => [], () => now);
    await expect(second.execute(second.trigger())).rejects.toThrow("network down");
    expect(store.state<Latest>("latest")).toEqual(latest); expect(store.state<{ selected: Selection[] }>("selection")!.selected).toEqual(selected);
  });
  test("duplicate trigger IDs share one immutable selection, and future/past triggers fail", () => {
    const { store, selected } = setup();
    const a = store.enqueue(start, selected, start);
    expect(store.enqueue(start, [...selected].reverse(), start)).toEqual(a);
    expect(() => store.enqueue(start + 600_000, selected, start)).toThrow();
    expect(() => store.enqueue(start - 600_000, selected, start)).toThrow();
    expect(() => store.enqueue(start + 1, selected, start)).toThrow();
    expect(() => store.enqueue(start + 600_000, selected.slice(1), start + 600_000)).toThrow("100");
  });
  test("two processes cannot own a lease; an expired owner cannot publish or release the new lease", () => {
    const dir = mkdtempSync(join(tmpdir(), "ingest-loop-")); dirs.push(dir);
    const { store, selected, accounts } = setup(100, join(dir, "state.sqlite"));
    const second = new LoopStore(join(dir, "state.sqlite")); stores.push(second);
    const a = store.claim(start)!; expect(second.claim(start)).toBeNull();
    const b = second.claim(start + 90_001)!; expect(b).toBeString();
    const run = store.enqueue(start, selected, start);
    expect(() => store.publish(run, accounts, {}, selected, a, start + 90_001)).toThrow("lease");
    store.release(a); expect(() => second.assertOwner(b, start + 90_001)).not.toThrow();
  });
  test("corrupt cached evidence fails recovery instead of publishing a repaired value", async () => {
    const { store, selected, accounts } = setup();
    const service = new LoopService(store, { async collect(account) { return { account, historyWarnings: [] }; } }, async () => selected, () => start);
    const run = service.trigger(), owner = store.claim(start)!;
    store.saveRecord(run.id, accounts[0].input.address, { account: accounts[0], historyWarnings: [] }, owner, start);
    store.release(owner); store.db.query("UPDATE blobs SET raw='corrupt' WHERE hash=?").run(accounts[0].rawHash);
    await expect(service.execute(run)).rejects.toThrow("corrupt"); expect(store.state("latest")).toBeNull();
  });
  test("worker overlap invokes only one collector and stale recovered rows are refreshed", async () => {
    const { store, selected, accounts } = setup(); let release!: () => void, calls = 0;
    const paused = new Promise<void>(r => { release = r; });
    const service = new LoopService(store, { async collect(account) { calls++; if (calls === 1) await paused; return { account, historyWarnings: [] }; } }, async () => selected, () => start);
    const run = service.trigger(); const a = service.start(run), b = service.start(run);
    expect(a).toBe(b); release(); await a; expect(calls).toBe(100);
    const newer = store.enqueue(start + 600_000, selected, start + 600_000), owner = store.claim(start + 600_000)!;
    store.saveRecord(newer.id, accounts[0].input.address, { account: accounts[0], historyWarnings: [] }, owner, start + 600_000); store.release(owner);
    let freshCalls = 0;
    const refresh = new LoopService(store, { async collect(account) { freshCalls++; return { account: { ...account, fetchedAt: new Date(start + 600_000).toISOString() }, historyWarnings: [] }; } }, async () => selected, () => start + 600_000);
    await refresh.execute(newer); expect(freshCalls).toBe(100);
  });
  test("cannot roll publication back to an older bucket", () => {
    const { store, selected, accounts } = setup(), owner = store.claim(start + 600_000)!;
    const old = store.enqueue(start, selected, start);
    const newer = store.enqueue(start + 600_000, selected, start + 600_000);
    store.publish(newer, accounts.map(a => ({ ...a, fetchedAt: new Date(start + 600_000).toISOString() })), {}, selected, owner, start + 600_000);
    expect(() => store.publish(old, accounts, {}, selected, owner, start + 600_000)).toThrow("monotonically");
  });
  test("HTTP serves only published blobs; stale latest is 503, archived artifact remains accessible", async () => {
    const { store, selected } = setup(); let now = start;
    const service = new LoopService(store, { async collect(account) { return { account, historyWarnings: [] }; } }, async () => selected, () => now);
    const fetch = loopHandler(store, service, () => now);
    expect((await fetch(new Request("http://localhost/ingest/latest"))).status).toBe(503);
    const secretish = store.blob("not a published artifact");
    expect((await fetch(new Request(`http://localhost/ingest/artifacts/${secretish}`))).status).toBe(404);
    await service.execute(service.trigger()); const latest = store.state<Latest>("latest")!;
    const receipt = await fetch(new Request(`http://localhost/ingest/receipts/${latest.receiptHash}`));
    expect(receipt.status).toBe(200); expect(((await receipt.json()) as { selected: string[] }).selected).toHaveLength(100);
    now += 900_001;
    expect((await fetch(new Request("http://localhost/ingest/latest"))).status).toBe(503);
    expect((await fetch(new Request(`http://localhost/ingest/artifacts/${latest.artifactHash}`))).status).toBe(200);
  });
  test("strict queue reproduces Score order and never promotes missing trade/classification evidence", () => {
    const { accounts } = setup(102);
    accounts[0].input.tradeCount = null; accounts[1].classification = null;
    const actual = priority(accounts, start);
    const expected = scoreCandidates(accounts.slice(1).filter(a => a.classification).map(a => a.input)).candidates.filter(c => c.eligible && c.score !== null).slice(0, 100).map(c => c.address);
    expect(actual.map(a => a.address)).toEqual(expected); expect(actual).toHaveLength(100);
    expect(actual.some(a => a.address === accounts[0].input.address)).toBe(false);
  });
  test("Consumer lookup stays on its requested bucket when a newer publication becomes latest", async () => {
    const { store, selected } = setup(); let now = start;
    const service = new LoopService(store, { async collect(account) {
      return { account: { ...account, fetchedAt: new Date(now).toISOString() }, historyWarnings: [] };
    } }, async () => selected, () => now);
    const fetch = loopHandler(store, service, () => now);
    const url = `http://localhost/ingest/runs/${runIdAt(start)}/publication`;
    expect((await fetch(new Request(url))).status).toBe(503);
    await service.execute(service.trigger());
    const original = await (await fetch(new Request(url))).json();
    now += 600_000;
    await service.execute(service.trigger());
    expect(await (await fetch(new Request(url))).json()).toEqual(original);
    const latest = await (await fetch(new Request("http://localhost/ingest/latest"))).json() as Latest;
    expect(latest.runId).toBe(runIdAt(now));
    expect(latest.bucket).toBe(start + 600_000);
  });
  test("scheduler resumes an unfinished previous bucket before starting the current one", async () => {
    const { store, selected } = setup(); let calls = 0, now = start;
    const first = new LoopService(store, { async collect(account) { if (++calls === 11) throw new Error("restart"); return { account, historyWarnings: [] }; } }, async () => selected, () => now);
    const original = first.trigger(); await expect(first.start(original)).rejects.toThrow("restart");
    now += 600_000;
    const resumed = new LoopService(store, { async collect(account) { return { account: { ...account, fetchedAt: new Date(now).toISOString() }, historyWarnings: [] }; } }, async () => selected, () => now);
    await resumed.tick();
    expect(store.run(original.id)!.status).toBe("complete");
    expect(store.run(runIdAt(now))).toBeNull();
    await resumed.tick(); expect(store.run(runIdAt(now))!.status).toBe("complete");
  });
  test("normal shutdown cancels the request, preserves failure state and releases ownership", async () => {
    const { store, selected } = setup(); let started!: () => void;
    const entered = new Promise<void>(resolve => { started = resolve; });
    const service = new LoopService(store, { async collect(_account, signal) {
      started(); await new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
      throw new Error("unreachable");
    } }, async () => selected, () => start);
    const run = service.trigger(), task = service.start(run); void task.catch(() => {});
    await entered; await service.stop();
    await expect(task).rejects.toThrow("shutdown");
    expect(store.run(run.id)!.status).toBe("failed"); expect(store.state("latest")).toBeNull();
    expect(store.claim(start)).toBeString(); expect(() => service.trigger()).toThrow("stopping");
  });
  test("recovery labels unfinished upstream attempts instead of counting them as observations", async () => {
    const { store, selected } = setup();
    const service = new LoopService(store, { async collect(account) { return { account, historyWarnings: [] }; } }, async () => selected, () => start);
    const run = service.trigger();
    store.requestAttempt("lost-request", run.id, { status: "started", startedAt: start - 1000 });
    await service.start(run);
    expect(store.requestAttempts(run.id)).toEqual([{ status: "interrupted", startedAt: start - 1000,
      finishedAt: start, error: "previous worker ended before recording an outcome" }]);
    expect(store.records(run.id).size).toBe(100);
  });
});

describe("persistent upstream budget and recovery", () => {
  test("rolling minute cap persists across clients and fills reservations refund observed weight", () => {
    const { store } = setup();
    for (let n = 0; n < 40; n++) expect(store.reserve("info", 20, 800, start).wait).toBe(0);
    expect(store.reserve("info", 20, 800, start + 1000).wait).toBe(59_001);
    expect(store.reserve("rpc", 1, 80, start).wait).toBe(0);
    const next = store.reserve("info", 120, 800, start + 60_001);
    expect(next.wait).toBe(0); store.refund(next.id, 21);
    expect(store.reserve("info", 779, 800, start + 60_001).wait).toBe(0);
    expect(store.reserve("info", 1, 800, start + 60_001).wait).toBeGreaterThan(0);
  });
  test("429 honors a 75-second Retry-After; retry is counted against the budget", async () => {
    const { store } = setup(); let now = start, calls = 0;
    const client = new BudgetClient(store, async () => ++calls === 1 ? new Response("", { status: 429, headers: { "Retry-After": "75" } }) : Response.json([]), () => now, async ms => { now += ms; });
    client.setContext({ runId: "budget-test", slot: 0, address: "0x1" });
    await client.request(SOURCES.info, { type: "portfolio" }, new AbortController().signal);
    expect(now - start).toBe(75_000); expect(calls).toBe(2); expect(client.rateLimited).toBe(1);
    const attempts = store.requestAttempts("budget-test") as { id: string; operationId: string; status: string; httpStatus: number; rawHash: string }[];
    expect(attempts).toHaveLength(2); expect(attempts[0].id).not.toBe(attempts[1].id);
    expect(attempts[0].operationId).toBe(attempts[1].operationId);
    expect(attempts[0].status).toBe("failed"); expect(attempts[0].httpStatus).toBe(429);
    expect(attempts[1].status).toBe("success"); expect(store.raw(attempts[1].rawHash)).toBe("[]");
  });
  test("4xx fails immediately, 5xx retries are bounded, and malformed success is rejected", async () => {
    const { store } = setup(); let now = start, calls = 0;
    const run = (status: number, raw = "") => new BudgetClient(store, async () => { calls++; return new Response(raw, { status }); }, () => now, async ms => { now += ms; });
    await expect(run(400).request(SOURCES.info, {}, new AbortController().signal)).rejects.toThrow("400"); expect(calls).toBe(1);
    calls = 0; await expect(run(503).request(SOURCES.info, {}, new AbortController().signal)).rejects.toThrow("503"); expect(calls).toBe(3);
    await expect(run(200, "truncated{").request(SOURCES.info, {}, new AbortController().signal)).rejects.toThrow();
  });
  test("cancellation stops a long Retry-After without a new request", async () => {
    const { store } = setup(), abort = new AbortController(); let calls = 0, now = start;
    const client = new BudgetClient(store, async () => { calls++; return new Response("", { status: 429, headers: { "Retry-After": "120" } }); }, () => now, async ms => { now += ms; abort.abort(); });
    await expect(client.request(SOURCES.info, {}, abort.signal)).rejects.toThrow(); expect(calls).toBe(1);
  });
});
